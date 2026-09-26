# D1 feasibility experiment

> Historical notes from the `playground` branch. The current app and commands
> are documented in the root README. Legacy probes now use `wrangler.probe.jsonc`
> and must never target the application database.

D1 feasibility playground for moving the searchable copy of local Codex and
Claude conversations to Cloudflare. Includes SQL probes and a small authenticated Worker probe, but not a complete
application or uploader.

## Run the probes

```sh
npm ci
npm test                 # Local D1 (workerd), no Cloudflare login required
npx wrangler login      # If not already authenticated
npm run test:remote     # Actual Cloudflare D1; requires D1 write permission
```

The configured database is `llm-session-search-playground`. Both probes delete
all sessions and records in their target database before inserting synthetic
fixtures. Use only a disposable database. Do not point this configuration at
real session data. Remote runs consume D1 read/write quota.

For another account, create a dedicated database with
`npx wrangler d1 create llm-session-search-playground` and replace the
`database_id` in `wrangler.jsonc`. Database IDs are identifiers, not credentials.
The SQL probes do not require a Worker deployment or Access configuration.

Detailed output is saved in ignored `results/local.json` and
`results/remote.json`. Authentication remains in Wrangler's external credential
store. Real conversation text is never loaded or uploaded by these probes.

## What is tested

`sql/schema.sql` adapts the schema from
`skaji/llm-session-search/internal/search/store.go`, omitting local SQLite
connection PRAGMAs. It retains the external-content FTS5 trigram table and its
insert/update/delete triggers.

Thirteen smoke assertions cover:

- English substring and case-insensitive phrase matching.
- Japanese trigram matching and one/two-character substring fallback.
- Session-level AND across separate messages, with working-directory scope.
- FTS updates after INSERT, UPDATE, DELETE, and foreign-key cascade deletion.
- Repeated UPSERT without duplicate records or postings.
- FTS external-content integrity checking.

The workload probe adds 1,000 synthetic messages across 20 sessions, then checks
rare/common/Japanese search counts, short-term scans, unchanged UPSERT, and the
session-level search query adapted from the Go implementation. It also measures
one-message insert/update/delete operations. The unchanged UPSERT must report
zero remote rows written.

## Results: September 26, 2026

Wrangler 4.141.0; local D1 and remote D1 in APAC/NRT both passed all smoke
assertions and workload result checks.

One remote run returned the following D1 metadata (not HTTP latency or Worker
CPU time):

| Operation | Rows read | Rows written | SQL duration (ms) |
| --- | ---: | ---: | ---: |
| Seed 1,000 messages and 20 sessions, including fixture cleanup | 2,028 | 4,064 | 127.77 |
| Rare trigram term, 10 matches | 10 | 0 | 0.91 |
| Common trigram term, 1,000 matches | 1,000 | 0 | 1.44 |
| Japanese trigram term, 100 matches | 100 | 0 | 0.36 |
| Two-character fallback, 100 matches | 1,000 | 0 | 3.06 |
| Unchanged one-message UPSERT | 4 | 0 | 0.41 |
| Session-level AND, 10 matching sessions | 3,060 | 0 | 5.37 |
| Append one message | 1 | 4 | 0.48 |
| Update that message | 1 | 3 | 0.56 |
| Delete that message | 1 | 2 | 0.59 |

Database size after seeding was 1,445,888 bytes, including indexes and internal
metadata. Fixtures are repetitive synthetic text; neither size nor performance
should be extrapolated directly to real transcripts. Timings are single-run
observations, not statistical benchmarks.

### Compatibility findings

- FTS5 `tokenize='trigram'`, external content, triggers, cascading deletes, and
  the existing session-level AND query work on actual D1.
- Conditional UPSERT avoids writes for unchanged content, but still incurs
  reads and a request. The CLI should skip unchanged data before sending it.
- Short search terms scan the text table; keep result sizes bounded and measure
  real workloads before deciding whether to restrict short queries.
- `PRAGMA page_count`/`page_size` and their table-valued query forms were rejected
  with `SQLITE_AUTH`. Use D1 response metadata (`size_after`) for storage metrics.
- Wrangler remote `--file` uses the import path, returns aggregate metadata,
  and can print progress before JSON. Schema/smoke probes use `--command` so
  individual SELECT assertions can be inspected; workload seeding uses `--file`.

## Worker binding probe

```sh
node scripts/probe-secret.mjs       # Generate .dev.vars without displaying the secret
npm test                           # Initialize and seed local D1 (destructive)
npm run dev                        # Port 8790; leave running in another terminal
npm run test:worker

# Actual Workers runtime + D1:
npm run deploy                     # Fails closed until PROBE_TOKEN is configured
node scripts/probe-secret.mjs --remote
npm run test:worker -- https://llm-session-search-worker.skaji.workers.dev
```

The remote database must already have `sql/schema.sql` applied; `npm run
test:remote` initializes it but deletes all fixtures. The Worker probe adds
synthetic data using a fresh device ID each run and does not delete older runs.
Run the SQL probe again to reset this disposable database when needed.

All Worker endpoints require `Authorization: Bearer <PROBE_TOKEN>`. The token
is stored in ignored `.dev.vars` locally and in a Worker secret remotely.
This is temporary probe authentication, **not Cloudflare Access authentication**.
Do not upload real transcripts. Access integration is a separate next step.
`PROBE_TOKEN` can override the local file when running the test client.

- `POST /update`: `{device, session, records: [{line, text}]}`. Up to 40 records
  and 128 KiB of JSON per request. `text: null` deletes a line. Uses one D1
  `batch()` with a session insert plus at most 40 record statements. Conditional
  UPSERT skips unchanged text. Device IDs are namespaced as `source=probe:<id>`
  to reuse the existing disposable schema; this is not the final cloud schema.
- `GET /search?term=first&term=second`: session-level AND across records, FTS5
  literal phrase matching for terms of 3+ codepoints, `instr` fallback for short
  terms. At most 5 terms and 20 result sessions. This minimal response excludes
  snippets, message details, ordering by activity, and pagination.
- `POST /rollback`: intentionally fail the second statement of a batch and
  verify that the first statement's record update and FTS trigger were rolled
  back. This fault-injection endpoint exists only for this playground.

The runner tests insert/change/retransmission for 1, 10, and 40 records (five
repeats each), English/Japanese/short search, cross-message AND, device
isolation, deletion/retry, rollback, missing authentication, and input limits.
Results including HTTP timing, D1 metadata, and Cloudflare Ray IDs are saved in
ignored `results/worker-local.json` and `results/worker-remote.json`.
Do not run reset probes concurrently with Worker probes.

### Worker results: September 26, 2026

Both local and remote runs passed all assertions. The remote run issued 73
requests, adding 259 synthetic records (then deleting one) on top of the
1,000-message SQL fixture. Typical messages were about 500 bytes; the largest
accepted measured batch was about 20 KiB. Oversized JSON was tested for
rejection, not processing performance near the 128 KiB ceiling.

| Operation | Records | Average HTTP ms (5 requests) | D1 rows written per request |
| --- | ---: | ---: | ---: |
| Insert into a new session | 1 | 58.55 | 7 |
| Insert into a new session | 10 | 42.39 | 43 |
| Insert into a new session | 40 | 70.58 | 163 |
| Change existing text | 40 | 61.98 | 120 |
| Retransmit unchanged text | 40 | 46.18 | 0 |
| English session search | — | 35.18 | 0 |
| Japanese session search | — | 37.04 | 0 |
| Short Japanese session search | — | 34.26 | 0 |

For the same 73 invocations, the Cloudflare dashboard's Worker Metrics CPU Time
chart reported **P50 0.96 ms, P90 2.22 ms, P99/P999 2.85 ms** and zero runtime
errors. CPU percentiles cover the mixed workload, including validation failures;
they are not per-operation measurements or a maximum. CPU was read from the
dashboard because the current Wrangler OAuth credential could not read the
Workers Observability telemetry API (403). To reproduce that observation, open
this Worker's **Metrics → CPU Time** chart after running the probe. Native
invocation logs are enabled at 100% sampling for further diagnosis.

This workload fits below the free plan's 10 ms CPU allowance. HTTP latency
includes network and database waits, so it must not be compared directly with
the CPU limit. Larger real transcripts, near-limit payloads, snippet generation,
Access authentication, and a growing index still need measurement. These are
small synthetic samples, not a capacity guarantee.

The useful result is that a bounded batch can maintain the records and FTS
index atomically, and retry without extra writes. A 40-record unchanged retry
still reads 80 D1 rows, so local change detection remains valuable.

## Next steps

Keep extraction and change detection in the Go CLI. Send only changed records,
identify their originating device, and make retransmission idempotent. Retain
local source files as the source of truth and provide a per-device rebuild path.
A new cloud database should use explicit schema migrations rather than copying
the local application's delete-and-rebuild upgrade policy blindly.

## References

- [D1 SQLite support](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing and row accounting](https://developers.cloudflare.com/d1/platform/pricing/)
- [Workers limits and CPU accounting](https://developers.cloudflare.com/workers/platform/limits/)
