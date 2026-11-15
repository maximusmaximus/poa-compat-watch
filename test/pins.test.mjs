import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonc, readPins, pinnedValues, writePins } from '../src/pins.mjs';
import { normalizeConfig, ConfigError } from '../src/config.mjs';
import { makeProject } from './helpers/project.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);


test('parseJsonc handles comments, trailing commas and comment-like strings', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }'), { a: 'http://x', b: [1, 2] });
});

test('read and rewrite json, regex and replaceAll pins', () => {
  const root = makeProject({
    'wrangler.jsonc': `{\n  // pins\n  "vars": { "ENGINE": "${A}", "PARAMS": "${B}", },\n}\n`,
    'src/net.ts': `export const ENGINE = "${A}";\nexport const PARAMS = "${B}";\n`,
    'test/fixture.mjs': `const pins = { engine: '${A}', params: '${B}', again: '${A}' };\n`,
  });
  const raw = { pins: [
    { tracks: 'engine', file: 'wrangler.jsonc', json: 'vars.ENGINE' },
    { tracks: 'params', file: 'wrangler.jsonc', json: 'vars.PARAMS' },
    { tracks: 'engine', file: 'src/net.ts', regex: 'ENGINE = "([0-9a-f]{64})"' },
    { tracks: 'params', file: 'src/net.ts', regex: 'PARAMS = "([0-9a-f]{64})"' },
    { tracks: 'engine', file: 'test/fixture.mjs', replaceAll: true },
    { tracks: 'params', file: 'test/fixture.mjs', replaceAll: true },
  ] };
  const cfg = normalizeConfig(raw, { root });
  const { values, problems } = pinnedValues(readPins(root, cfg.pins));
  assert.deepEqual(problems, []);
  assert.deepEqual(values, { engine: A, params: B });
  const { changed, notes } = writePins(root, cfg.pins, values, { engine: C, params: D });
  assert.deepEqual(notes, []);
  assert.deepEqual(changed.sort(), ['src/net.ts', 'test/fixture.mjs', 'wrangler.jsonc']);
  const w = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
  assert.ok(w.includes('// pins') && w.includes(C) && w.includes(D) && !w.includes(A));
  assert.equal((fs.readFileSync(path.join(root, 'test/fixture.mjs'), 'utf8').match(new RegExp(C, 'g')) || []).length, 2);
  assert.deepEqual(pinnedValues(readPins(root, cfg.pins)).values, { engine: C, params: D });
});

test('disagreeing pins are reported', () => {
  const root = makeProject({ 'a.json': `{"e":"${A}"}`, 'b.txt': `E=${C}` });
  const cfg = normalizeConfig({ pins: [{ tracks: 'engine', file: 'a.json', json: 'e' }, { tracks: 'engine', file: 'b.txt', regex: 'E=([0-9a-f]{64})' }] }, { root });
  assert.match(pinnedValues(readPins(root, cfg.pins)).problems[0], /disagree/);
});

test('config validation', () => {
  assert.throws(() => normalizeConfig({ pins: [{ tracks: 'nope', file: 'x', json: 'a' }] }), ConfigError);
  assert.throws(() => normalizeConfig({ pins: [{ tracks: 'engine', file: 'x' }] }), ConfigError);
  assert.throws(() => normalizeConfig({ pins: [{ tracks: 'engine', file: 'x', regex: 'no-group' }] }), ConfigError);
  assert.throws(() => normalizeConfig({ pins: [{ tracks: 'engine', file: '../outside', json: 'a' }] }, { root: '/tmp/p' }), ConfigError);
});
