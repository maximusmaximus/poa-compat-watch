# poa-compat-watch

Read-only checker for the live [Proof of Agent](https://minepoa.com) network. It fetches current core values, compares them with a committed baseline and with the pins of Max Infeld's PoA apps, and classifies each app as **compatible**, **needs-update**, or **breaking**.

No runtime dependencies. Node.js 20 or newer. MIT licensed. The checker only makes GET requests. It hashes the official client bundle with Web Crypto and never executes it. It does not sign or submit transactions, and it does not read or write wallets, keys, or secrets.

An hourly Cloudflare Worker runs the same check and publishes the latest result and last-change history as public JSON.

## What it checks

Against `https://minepoa.com` (override with `--source`):

- network-facts at `/chain/poa-mainnet-1/api/network-facts` and `/api/network-facts` (`chain_id`, `engine_sha256`, `params_sha256`, `K`)
- status at `/chain/poa-mainnet-1/api/status` (and `/api/status` for comparison)
- params at `/chain/poa-mainnet-1/api/params`, falling back to `/api/params` (`decimals`, `K`)
- the official client bundle at `/chain/poa-mainnet-1/client/poa.mjs` and `/client/poa.mjs` (sha256)
- a sample receipt (`/api/receipt/:id` and the chain path) and explorer tx (`/api/explorer/tx/:id`), recording field names only
- a transfer body field set when a transfer appears in the explorer listing
- availability of the endpoints listed in `baseline.json`, including optional public routes used by the operator console and toolkit (`/api/epochs`, `/api/agents`, `/api/notices`, `/api/ballots`, `/api/networks`)

`baseline.json` is the known-good snapshot of those values, including the transfer body field set used by `poa.mjs` and poa-dice (`type`, `from`, `to`, `amount`, `memo`, `nonce`, `parents`, `ts`, `cid`, `sig`).

Authenticated hosted routes (`/api/hosted/*`) are listed on the apps that use them and are not requested by this checker.

Classification:

- **compatible** — live values match the baseline and the app's pins; extra receipt or explorer fields are allowed
- **needs-update** — engine, params, or client-bundle hashes moved, or a required capability stayed down after retries, or the baseline field set is missing live fields, while wire identity (`chain_id`, `decimals`, required transfer/receipt fields) still holds
- **breaking** — `chain_id` or `decimals` changed, an observed transfer body is missing required fields, or an app's required receipt shape no longer matches

Busy or paused answers (HTTP 503, 429, 502, 504) are retried. A transient success after retry is not a failure. A persistent 503 on a flaky or fallback path (for example `/api/txs`) is an availability warning, not a break. If every path for a required capability stays down after retries, the baseline is **needs-update**. If network-facts cannot be read at all, the checker exits 3.

Root `/api/status` currently uses a different schema and tx counts than chain status. The checker reports that as a warning and uses chain status as the primary status document.

## Apps

| Manifest | What it pins or depends on |
| --- | --- |
| `apps/poa-domains.json` | Engine and params hash pins and their file locations, official client URL, accepted receipt shapes (legacy or slim), transfer body field set |
| `apps/poa-dice.json` | Chain id, 6-decimal amounts, transfer body field set, receipt fields (`status`, `next_nonce`, `checkpoint_covered`), explorer/receipt endpoints. It does not pin engine or params hashes. |
| `apps/proof-floor.json` | Chain id, public status/epochs/agents/explorer routes used by the operator console. Hosted `/api/hosted/*` routes are documented and not probed. |
| `apps/poa-agent-kit.json` | Chain id (`MAINNET_CHAIN_ID`), default node `https://minepoa.com`, public epochs/receipt/explorer routes. Hosted routes are documented and not probed. |
| `apps/poa-keygen.json` | Official client bundle URL, `K = 5` in the balance checker, public explorer/receipt GETs used by `check.html`. Key generation itself is offline. |

To add another app, put a manifest in `apps/`, import it from `src/catalog.mjs`, and run `npm test`.

## How to run

From this repository:

```sh
node src/check.mjs
node src/check.mjs --json
```

Equivalent npm scripts: `npm run check` and `npm run check:json`.

Useful options: `--source <url>`, `--baseline <file>`, `--apps <dir>`, `--retries <n>`, `--timeout <ms>`. `--fixture <file>` replays a saved live observation and does not use the network (this is how the tests drive the CLI).

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | compatible |
| 1 | needs-update |
| 2 | breaking |
| 3 | checker error (invalid baseline/apps, or the live node could not be read) |

The process exit code is the most severe of the baseline and app results. Warnings do not change the exit code.

## Hourly Worker

The Worker in `worker/index.mjs` runs the same `fetchLive` + `compare` path as the CLI. A cron trigger (`0 * * * *`) stores the latest report and last-change history in the `poa-compat-watch-results` KV namespace, bound as `RESULTS`. If no result is stored yet, the first `GET /latest.json` runs the check once and stores it.

Public Worker: `https://poa-compat-watch.maxinfeld-artshow.workers.dev`

Public endpoints (no secrets in the output):

- `GET /latest.json` — latest report
- `GET /history.json` — last-change history (a new entry only when the classification, core hashes, or an app classification changes)
- `GET /` — short index

Deploy from this repository (requires a logged-in Wrangler session on the target account):

```sh
npx wrangler deploy
```

## How to update the baseline

1. Run `node src/check.mjs` and read the evidence (expected vs live).
2. If the live values are accepted, write them into `baseline.json`:

   ```sh
   node src/check.mjs --write-baseline
   ```

   This keeps existing capability metadata (required/flaky flags) and refreshes hashes, `K`, `decimals`, and observed field sets. It will not write a baseline if the live fetch failed. If no transfer was observed, the committed transfer field set is left unchanged.
3. If an app pin is stale, update the corresponding file under `apps/` to the new live value.
4. Review the diff, run `npm test`, and commit. After that commit is deployed, the Worker uses the new baseline.

## Tests

```sh
npm test
```

The tests use fixtures and a mock network only. They cover compatible, needs-update, breaking, availability-warning, and checker-error cases, plus the app catalog and history recording.

## License

MIT
