# llm-session-search-worker

Private Codex and Claude conversation search across your computers. A Go CLI
reads local JSONL files, uploads only changed messages, and a TypeScript
Cloudflare Worker searches the shared D1 copy. Local JSONL files remain the
source of truth. This is a small, personal application, not a multi-user service.

## Worker

The deployment URL and allowed email are configured in the untracked `settings.json`.
The application database is `llm-session-search`; it is separate from the
throwaway `llm-session-search-playground` database.

```sh
npm ci
cp settings.example.json settings.json
# Edit settings.json: set url (HTTPS origin) and email.
npm run db:remote     # Apply schema migrations
npm run deploy
```

`npm run deploy`, `npm run dev`, and the database migration commands read
`settings.json` and generate the ignored `wrangler.local.json` from `wrangler.jsonc`.
The URL hostname becomes the Worker custom domain; the email becomes `ALLOWED_EMAIL`
and the local development identity. The URL must be an HTTPS origin without a path.
Keep `settings.json` on each development/deployment machine; it is not committed.
Use the npm commands rather than invoking `wrangler deploy` directly.

In Cloudflare, protect **all traffic** to this Worker with an Access policy allowing only
the `email` in `settings.json`. In its Zero Trust application, enable only
One-time PIN and choose the desired session duration. These settings are
managed in Cloudflare, not by `npm run deploy`.

The Worker also requires `ctx.access.getIdentity().email` to match
`ALLOWED_EMAIL` (the `email` in `settings.json`). With Access missing or misconfigured,
it returns 403. Arbitrary email headers and the old probe secret cannot bypass
this check. Native invocation logs are disabled to avoid storing search terms
from request URLs in Workers Logs. Error logs contain no request data.

The browser UI supports words or quoted phrases, session-level AND across
messages, device and working-directory filters, recent sessions, and paginated
message reading. Text is escaped and rendered as plain text, not HTML or Markdown.
Browser searches submitted with the Search button are saved in D1 per authenticated
email. The latest 20 distinct queries are shared across devices; repeating a query
moves it to the top. Recent-search buttons rerun only the query, without device or
directory filters. Clear history removes that user's saved queries. Empty searches,
page navigation, reloads, and CLI/API searches do not write history.

The logout link uses Cloudflare's logout endpoint, which can also invalidate
sessions for other applications in the same Zero Trust organization.

## Install and configure the CLI

Requires Go 1.27 or later. The CLI supports macOS and Linux.

```sh
go install ./cmd/llm-session-sync
worker_url=$(node -p 'JSON.parse(require("fs").readFileSync("settings.json", "utf8")).url')
llm-session-sync configure -url "$worker_url"
llm-session-sync
```

Configure the CLI once with the URL from `settings.json` (or pass that URL
with `-url` on its first run). It saves the URL and asks for:

1. A unique, stable name for this computer, such as `macbook-air` or `imac`.
2. A Cloudflare Access **application JWT** for this Worker's URL.

Token input is hidden. The configuration is saved to
`~/.llm-session-search-worker/config.json` with mode 0600. All CLI-owned
checkpoints, PID files, and logs live under that directory (created with mode
0700). Never commit or share it. Use distinct device names on different computers.

To obtain a token using an existing `cloudflared` installation:

```sh
cloudflared access login "$worker_url"
```

Authenticate in the browser using the `email` in `settings.json` and paste the application token
when the CLI asks. Its lifetime follows the actual issued token; changing an
Access setting does not extend an existing token. Cloudflare API tokens and
service tokens are not accepted here.

To change the saved token or device name:

```sh
llm-session-sync configure
```

Alternatively, `llm-session-sync login` runs `cloudflared`'s browser login and
saves the resulting token without printing it. The normal sync path does not
require `cloudflared`; it uses the configured token directly.

Changing the device name creates another cloud copy. Delete the old copy
explicitly if that is not intended. To use another Worker, run
`llm-session-sync configure -url https://your-worker.example.com`; changing
origins clears the previous token.

## Sync and daemon

With no command, the CLI syncs once. Default input directories are `$CODEX_HOME`
(or `~/.codex`) and `$CLAUDE_CONFIG_DIR` (or `~/.claude`). Codex archived sessions
are included. Claude subagent files are excluded, matching the local app.

Session update times use the latest timestamp among the displayed user and
assistant messages. Hidden events and file modification times do not affect
them. If no displayed message has a valid timestamp, the API returns
`updated_at_ms: 0` and the UI shows "Unknown update time".

To update previously synced timestamps, upgrade the CLI on each source device
and run a normal sync (restart any running daemon to use the new binary).
Every sync rereads the local logs and uploads changed metadata, preserving
session IDs and URLs; no database migration or `-rebuild` is needed. Sessions
whose source logs are no longer available cannot be corrected from the cloud
copy alone, because individual message timestamps are not stored there.

```sh
llm-session-sync -dry-run             # Parse and count; no uploads or state changes
llm-session-sync                      # Sync once
llm-session-sync -daemon              # Sync now, then every minute
llm-session-sync -daemon-status       # Running PID and token validity
llm-session-sync -daemon-stop
llm-session-sync -daemon -interval 5m
```

The daemon writes `~/.llm-session-search-worker/app.pid` and appends logs to
`~/.llm-session-search-worker/app.log`. A PID-file lock prevents duplicate
daemons. Startup, shutdown, and sync errors (including token expiry or authentication
rejection) are logged; successful periodic syncs produce no log output.
The daemon reads the configuration before each sync, so `configure` or `login`
can replace the token without a restart. It does not renew tokens automatically.
`-daemon-status` checks local expiration and, for an unexpired token, asks the
Worker to verify access. Network errors are reported as **unknown**, not invalid.
An idle sync sends no requests, even if the token has expired; status can check
it explicitly. The daemon does not automatically start after a reboot, and the
log is not rotated automatically.

Input-directory overrides are available as `-codex-home` and `-claude-home`;
pass an empty value to disable one source. `-data-dir` overrides the default
configuration directory for testing.

By default, missing local session files do not remove cloud sessions. To remove
previously synced sessions that have disappeared locally:

```sh
llm-session-sync -prune
```

To rebuild this device's cloud copy, including after losing a checkpoint or
recreating the remote database:

```sh
llm-session-sync -rebuild
```

Run rebuild as a one-shot command, not a daemon option. It deletes only the
configured device's copy, then uploads the local source again. It is not an
atomic whole-device replacement, so search may temporarily show partial results.

## Search from the CLI

Flags must precede search words or the session ID. Output is JSON.

```sh
llm-session-sync search 'github actions'
llm-session-sync search -cwd /Users/skaji/src/github.com/skaji '"a phrase"'
llm-session-sync search -filter-device imac -offset 20 database
llm-session-sync show 123
llm-session-sync show -after 100 123
```

Search returns up to 20 sessions with `next_offset`. Message retrieval returns
up to 20 records with `next_after`. Source paths and line numbers refer to the
originating computer; the message endpoint makes local file access unnecessary.

## Design and current limits

- The parsers are adapted from `github.com/skaji/llm-session-search`. They extract
  user/assistant conversation text, omit tool payloads, and remove known injected
  context. They have no dependency on that app or its running server.
- Each sync scans and hashes local messages. Unchanged records and metadata
  cause no HTTP requests. This favors a simple implementation over incremental
  local file-offset tracking.
- Identity is `(device, source, source_id)`; records are keyed by JSONL line.
  Changes, appended messages, and removed lines become bounded delta batches.
- A request contains at most 40 records and 128 KiB of JSON. The CLI also checks
  encoded byte size, including JSON escaping. A D1 batch updates the session,
  records, and FTS index atomically. Different batches can be visible separately.
- **Long messages are currently limited to roughly 16 KiB**, retaining the
  beginning and end with an explicit `[truncated]` marker. Original JSONL files
  are untouched. This bounds Worker CPU and response sizes; it is a limitation
  of this first version, not a D1 requirement.
- Checkpoints store metadata and record hashes. A pending batch temporarily
  includes its message text so a failed or interrupted request can be replayed
  before calculating the next delta. Successful batches are checkpointed locally.
  Duplicate requests are idempotent; no conflict resolution across competing
  uploaders with the same device ID is attempted.
- UTF-8 queries of at least three characters use FTS5 trigram; shorter terms scan
  text. Up to five terms are allowed. SQLite's built-in case folding applies.
- Images, attachments, tool output, and arbitrary Markdown rendering are outside
  the current scope. Existing transcript secrets are not automatically redacted.

## Development and tests

```sh
npm run db:local
npm run dev                     # 127.0.0.1:8790, separate from the local app's 8787
npm run typecheck
npm test                        # Worker + Go CLI + daemon integration, synthetic data

gofumpt -w cmd internal
goimports -w cmd internal
go build ./...
go test ./...
golangci-lint run ./...
```

`npm run dev` sets an `access.dev` identity from `settings.json` solely for local development.
It is not deployed as an authentication bypass. Use a separate CLI data directory
with `configure -data-dir /tmp/session-search-dev -url http://127.0.0.1:8790`
and synthetic input directories for local manual testing. Local setup does not
ask for an Access token.

The original feasibility results are in [docs/d1-experiment.md](docs/d1-experiment.md).
Legacy SQL probes now use `wrangler.probe.jsonc` and the disposable playground
D1 only. Run them with `npm run probe:d1` or `npm run probe:d1:remote`. They delete
fixtures in that disposable database. The legacy probe Worker is not deployed
by the main configuration; its source is retained as `src/probe.js`.

## CLI releases

`llm-session-sync -version` prints the release version (for example, `0.1.0`).
Plain `go build` builds report `dev`. This command does not require CLI configuration.

Pushing a version tag such as `v0.1.0` runs the release workflow. After Go tests
pass, GoReleaser creates a GitHub Release with these archives and `checksums.txt`:

- `llm-session-sync-darwin-arm64.tar.gz`
- `llm-session-sync-linux-amd64.tar.gz`
- `llm-session-sync-linux-arm64.tar.gz`

Each archive contains the CLI, README, and example settings. Local settings and
credentials are not included. The workflow uses the built-in `GITHUB_TOKEN`;
no Cloudflare credentials are needed. It does not deploy the Worker.

To validate packaging locally without publishing:

```sh
goreleaser check
goreleaser release --snapshot --clean
```
