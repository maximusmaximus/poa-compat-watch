# poa-compat-watch

Keep projects built on [Proof of Agent (PoA)](https://minepoa.com) working when the PoA core changes.

`poa-compat` reads PoA's public network surface (network facts, node status, the signed release
manifest and the official client bundle), compares it with what your project pins or relies on,
and tells you whether you are **compatible**, **need an update**, or are **broken**. It can then
rewrite your pins, record evidence, run your tests and open a pull request, with auto-merge only
when the app cannot work until the update lands.

No dependencies. Node.js 20 or newer. MIT licensed.

## Quick start

```sh
npx github:maximusmaximus/poa-compat-watch status        # what is PoA running right now?
npx github:maximusmaximus/poa-compat-watch check          # uses ./poa-compat.json
```

`status` prints the live engine hash, params hash, client bundle sha256, release name, network id
and epoch. It retries busy (503) answers and works without a config file.

## Commands

| Command | What it does |
| --- | --- |
| `status [--json] [--pinned <engine>]` | Live engine, params, client sha256, release, network id/epoch. With `--pinned`, how many releases behind that engine is. |
| `check [--config f] [--json]` | Compares live values with your declared pins and surface snapshot. |
| `diff [--old f\|url\|snapshot] [--new f\|url] [--json]` | Structural diff of two client bundles. Defaults: your snapshot vs the live bundle. |
| `update [--skip-tests] [--force]` | Rewrites pins to live values, refreshes the snapshot, appends evidence, runs your tests, writes a report. |
| `pr [--auto-merge-when never\|breaking] [--dispatch-workflow ci.yml] [--dry-run]` | Commits the update to one rolling branch and opens or updates a pull request with the report as its body. |
| `snapshot [--bundle f]` | Records the surface of the live (or given) bundle as your baseline. |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | compatible |
| 10 | needs update: hashes moved, nothing your project relies on broke |
| 20 | breaking: a relied-on part of the surface changed, the network no longer matches your expectations, or a pin moved and your app refuses to run on unpinned values |
| 1 | usage or config error, or an update was refused |
| 2 | network unavailable |
| 3 | `update` applied changes but a test failed |

## What "structural change" means

`diff` and `check` read the client bundle as text (it is never executed) and extract:

- **exports** and their parameter lists
- **code fingerprints** of top-level functions (comments and whitespace ignored)
- **transaction types** the bundle handles (`type === 'transfer'` and similar)
- **field names** used on transaction bodies, receipts, checkpoints and params
- **constants** (upper-case top-level values)

Each difference is graded for *your* project using the `uses` lists in your config:

- removed export, changed parameters, removed tx type or field, or a changed watched constant that
  you rely on: **breaking**
- any code change in a function you mark `critical` (for example `canonical`, `txidOf`, `signBody`):
  **breaking**, because those define the wire format
- a new trailing parameter, or code changes in other functions you use: **worth a look**
- everything else: informational

Without a `uses` list, every removal counts as breaking.

## Config: `poa-compat.json`

```json
{
  "project": "my-app",
  "network": {
    "origin": "https://minepoa.com",
    "chainId": "poa-mainnet-1",
    "clientMustMatch": "engine",
    "expectFacts": { "chain_id": "poa-mainnet-1", "economics.K": 5 },
    "expectStatus": { "K": 5 }
  },
  "failClosedOnPinMismatch": true,
  "pins": [
    { "tracks": "engine", "file": "wrangler.jsonc", "json": "vars.ENGINE_SHA256" },
    { "tracks": "params", "file": "src/network.ts", "regex": "PARAMS_SHA256 = \"([0-9a-f]{64})\"" },
    { "tracks": "engine", "file": "test/fixtures.mjs", "replaceAll": true }
  ],
  "surface": {
    "snapshot": ".poa-compat/surface.json",
    "uses": {
      "exports": ["canonical", "txidOf", "signBody"],
      "critical": ["canonical", "txidOf", "signBody"],
      "txTypes": ["transfer"],
      "fields": { "body": ["type", "from", "to", "amount", "memo", "nonce", "parents", "ts", "sig"] },
      "constants": []
    }
  },
  "evidence": ".poa-compat/evidence.json",
  "tests": ["npm ci", "npm test"],
  "pr": { "base": "main", "branch": "poa-compat/update", "titlePrefix": "PoA core update" }
}
```

- **pins**: every place your code stores a PoA value. `tracks` is `engine`, `params` or `client`.
  Use `json` (dot path, JSONC comments are fine), `regex` (one capture group around the value) or
  `replaceAll` (every occurrence of the previous value in that file, for fixtures and docs). All
  pins of one kind must agree, or `check` reports it and `update` refuses.
- **failClosedOnPinMismatch**: set when your app stops working if the network runs a different
  engine or params than it pins (for example a payment path that halts). A moved pin is then
  **breaking** rather than **needs update**.
- **clientMustMatch**: `engine` (served bundle must hash to the advertised engine), `release`
  (must match the release manifest `client_sha256`, the default) or `none`. `update` refuses to
  write anything when this check fails.
- **surface**: projects without pins can still watch the client surface; the snapshot records the
  last bundle you were checked against.
- **tests**: run in order from the project root after an update; the first failure stops the run.
- **report**: where `update` writes the JSON and Markdown report (default: a temp directory).

Run `poa-compat snapshot` once to record your baseline, and commit `.poa-compat/`.

## GitHub Action

`examples/poa-compat.yml` is a ready workflow: every 30 minutes and on demand it runs
`check`, then `update` and `pr` when something moved.

```yaml
- uses: maximusmaximus/poa-compat-watch@<commit-sha>
  with:
    config: poa-compat.json
    github-token: ${{ steps.app.outputs.token || github.token }}
    auto-merge-when: breaking
    dispatch-workflow: ci.yml
```

Auto-merge is enabled only when **all** of these hold:

1. the project is classified **breaking** (users cannot use it on the current core),
2. the client surface has no breaking change (so updating pins is enough; code changes always get
   a human review),
3. the network still matches your expectations and the served bundle passed the integrity check,
4. at least one test command is configured and every one passed.

Otherwise the pull request stays open for review, and any earlier auto-merge on it is turned off.
GitHub then merges only after the repository's own required checks pass, so keep your normal CI
required on the base branch. Auto-merge must be allowed in the repository settings.

### Pull requests and CI

GitHub does not start workflows for events caused by the default `GITHUB_TOKEN`. An update pull
request opened with it gets no CI runs, and auto-merge will wait forever on required checks. Pick
one:

1. **GitHub App (recommended).** Create an App with *Contents* and *Pull requests* read/write,
   install it on the repository, store its id as variable `POA_COMPAT_APP_ID` and its private key
   as secret `POA_COMPAT_APP_PRIVATE_KEY`. The example workflow mints a short-lived token with
   `actions/create-github-app-token`, and the action pushes and opens the pull request with it.
2. **Fine-grained personal access token** limited to the repository with *Contents* and *Pull
   requests* read/write, stored as a secret and passed as `github-token` (and to
   `actions/checkout`).
3. **Dispatch CI explicitly.** Keep `GITHUB_TOKEN`, add `workflow_dispatch:` to your CI workflow and
   set `dispatch-workflow: ci.yml`. `workflow_dispatch` events are allowed from `GITHUB_TOKEN`, and
   the resulting check runs attach to the update commit. With `GITHUB_TOKEN`, also enable
   *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests*.

Tokens are only read from the environment (`GH_TOKEN`); they are never put on a command line,
printed or written to reports. Test output in reports is passed through a redaction filter, and a
secret scan runs on every changed file before anything is pushed.

### Deploys

Merging an update pull request runs whatever your repository does on merge. If production deploys
wait for an environment approval, auto-merge does not deploy by itself; decide whether to keep that
gate or let a merged compatibility update deploy automatically.

## Adding a project

1. Add `poa-compat.json` listing your pins, the parts of the client you rely on, and your tests.
2. Run `poa-compat snapshot` and `poa-compat check`; commit `.poa-compat/`.
3. Copy `examples/poa-compat.yml` to `.github/workflows/` and pick one of the CI options above.

## Development

```sh
npm test                      # unit and CLI tests against a local mock network
node scripts/secret-scan.mjs  # run before every push
```

## License

MIT
