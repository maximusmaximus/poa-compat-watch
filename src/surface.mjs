// Structural "API surface" of a JavaScript client bundle, extracted without executing it.
// Heuristic by design: it reads the bundle as text, so it works on any ES module build.
import { createHash } from 'node:crypto';

export const SURFACE_VERSION = 1;

export const DEFAULT_SHAPES = Object.freeze({
  // Field names read or written on these objects anywhere in the bundle.
  body: '\\bbody\\.([A-Za-z_$][\\w$]*)',
  receipt: '\\breceipt\\.([A-Za-z_$][\\w$]*)',
  checkpoint: '\\bcheckpoint\\.([A-Za-z_$][\\w$]*)',
  params: '\\bparams\\.([A-Za-z_$][\\w$]*)',
});

const short = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** Replace comments with spaces and string/template/regex contents with placeholders, keeping offsets. */
export function maskSource(src) {
  const out = src.split('');
  let i = 0;
  let lastSig = '';
  const n = src.length;
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') { depth++; j += 2; continue; }
        if (c === '`' && depth > 0 && src[j] === '}') { depth--; j++; continue; }
        if (src[j] === c && depth === 0) break;
        if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1; lastSig = 'x'; continue;
    }
    if (c === '/' && (lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || /\b(return|typeof|case|in|of|void|delete|throw)\s*$/.test(src.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1, cls = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      if (src[j] === '/') { blank(i + 1, j); i = j + 1; while (/[a-z]/.test(src[i] || '')) i++; lastSig = 'x'; continue; }
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.join('');
}

function matchClose(masked, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

function splitTop(s) {
  const parts = [];
  let depth = 0, cur = '';
  for (const c of s) {
    if ('([{'.includes(c)) depth++;
    if (')]}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** "a, b = 1, { c, d } = {}" -> "a,b,{c,d}" (defaults dropped, whitespace removed). */
export function normalizeParams(raw) {
  return splitTop(raw).map((p) => {
    let depth = 0, cut = p.length;
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) depth--;
      if (c === '=' && depth === 0 && p[i + 1] !== '>') { cut = i; break; }
    }
    let q = p.slice(0, cut).replace(/\s+/g, '');
    // drop defaults inside destructuring too: {a=1,b} -> {a,b}
    q = q.replace(/=[^,{}\[\]]+/g, '');
    return q;
  }).filter(Boolean).join(',');
}

const normBody = (s) => s.replace(/\s+/g, ' ').trim();

/** Extract the structural surface of a bundle. */
export function extractSurface(src, { shapes = DEFAULT_SHAPES } = {}) {
  const masked = maskSource(src);
  const exports = {};
  const functions = {};
  const constants = {};
  // Top-level function declarations (exported or not) so critical internals can also be fingerprinted.
  const fnRe = /^(export\s+)?(async\s+)?function\s*(\*?)\s*([A-Za-z_$][\w$]*)\s*\(/gm;
  for (let m; (m = fnRe.exec(masked));) {
    const name = m[4];
    const pOpen = m.index + m[0].length - 1;
    const pClose = matchClose(masked, pOpen);
    if (pClose < 0) continue;
    const bOpen = masked.indexOf('{', pClose);
    const bClose = bOpen < 0 ? -1 : matchClose(masked, bOpen);
    const params = normalizeParams(masked.slice(pOpen + 1, pClose));
    const body = bClose < 0 ? '' : src.slice(bOpen, bClose + 1);
    const maskedBody = bClose < 0 ? '' : masked.slice(bOpen, bClose + 1);
    functions[name] = { params, bodyHash: short(normBody(stripComments(body, maskedBody))) };
    if (m[1]) exports[name] = { kind: m[2] ? 'async function' : m[3] ? 'generator' : 'function', params };
  }
  // const / let declarations at column 0.
  const constRe = /^(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/gm;
  for (let m; (m = constRe.exec(masked));) {
    const name = m[3];
    const start = m.index + m[0].length;
    const rest = masked.slice(start, start + 400);
    let kind = 'const', params = null, body = '';
    const arrow = /^(async\s+)?(\(|[A-Za-z_$][\w$]*\s*=>)/.exec(rest);
    if (arrow) {
      if (arrow[2] === '(') {
        const pClose = matchClose(masked, start + arrow[0].length - 1);
        if (pClose > 0 && /^\s*=>/.test(masked.slice(pClose + 1, pClose + 8))) {
          kind = arrow[1] ? 'async function' : 'function';
          params = normalizeParams(masked.slice(start + arrow[0].length, pClose));
        }
      } else { kind = arrow[1] ? 'async function' : 'function'; params = arrow[2].replace(/\s*=>$/, '').trim(); }
    }
    const end = statementEnd(masked, start);
    body = src.slice(start, end);
    const mbody = masked.slice(start, end);
    if (kind !== 'const') functions[name] = { params, bodyHash: short(normBody(stripComments(body, mbody))) };
    if (m[1]) exports[name] = kind === 'const' ? { kind: 'const' } : { kind, params };
    if (/^[A-Z][A-Z0-9_]*$/.test(name) && kind === 'const') {
      const lit = /^(['"`])((?:\\.|(?!\1).)*)\1\s*;?$|^(-?\d[\d_.e+n]*|true|false|null)\s*;?$/.exec(body.trim());
      constants[name] = lit ? (lit[2] !== undefined ? lit[2] : lit[3]) : `sha256:${short(normBody(stripComments(body, mbody)))}`;
    }
  }
  for (const m of masked.matchAll(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm)) exports[m[1]] = { kind: 'class' };
  for (const m of masked.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim(); if (!t) continue;
      const [local, alias] = t.split(/\s+as\s+/);
      const name = (alias || local).trim();
      exports[name] = exports[name] || { kind: 'reexport', of: local.trim() };
    }
  }
  if (/^export\s+default\b/m.test(masked)) exports.default = { kind: 'default' };

  // Transaction type names compared or assigned anywhere: type === 'transfer', type: 'transfer'.
  const txTypes = new Set();
  for (const m of src.matchAll(/\btype\s*(?:={2,3}|!={1,2}|:)\s*['"]([a-z][a-z0-9_-]*)['"]/g)) txTypes.add(m[1]);
  for (const m of src.matchAll(/\bcase\s+['"]([a-z][a-z0-9_-]*)['"]\s*:/g)) if (/\btype\b/.test(src.slice(Math.max(0, m.index - 2000), m.index))) txTypes.add(m[1]);

  const shapeOut = {};
  for (const [name, pattern] of Object.entries(shapes || {})) {
    const set = new Set();
    for (const m of masked.matchAll(new RegExp(pattern, 'g'))) set.add(m[1]);
    // Keys of object literals assigned to a variable of that name: const body = { a, b: 1, ...rest }.
    for (const m of masked.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*\\{`, 'g'))) {
      const open = m.index + m[0].length - 1;
      const close = matchClose(masked, open);
      if (close < 0) continue;
      for (const part of splitTop(masked.slice(open + 1, close))) {
        const k = /^\s*([A-Za-z_$][\w$]*)\s*(?::|,|$)/.exec(part);
        if (k) set.add(k[1]);
      }
    }
    shapeOut[name] = [...set].sort();
  }
  return {
    surfaceVersion: SURFACE_VERSION,
    exports: sortObj(exports),
    functions: sortObj(functions),
    constants: sortObj(constants),
    txTypes: [...txTypes].sort(),
    shapes: shapeOut,
  };
}

function stripComments(body, masked) {
  // Keep code and string contents, drop comments: take chars where masked has non-space, or where src is inside a string.
  let out = '';
  let inStr = false;
  for (let i = 0; i < body.length; i++) {
    const m = masked[i], s = body[i];
    if (m === ' ' && s !== ' ' && s !== '\n' && s !== '\t' && s !== '\r') { out += inStr ? s : ' '; continue; }
    if (m === '"' || m === "'" || m === '`') inStr = !inStr;
    out += s;
  }
  return out;
}

function statementEnd(masked, start) {
  let depth = 0;
  for (let i = start; i < masked.length; i++) {
    const c = masked[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { depth--; if (depth < 0) return i; }
    else if (c === ';' && depth === 0) return i;
    else if (c === '\n' && depth === 0) {
      const next = masked.slice(i + 1).match(/^\s*(\S)/);
      if (!next || !/[.?:+\-*/&|,=)]/.test(next[1])) return i;
    }
  }
  return masked.length;
}

function sortObj(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}
