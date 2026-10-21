# NetScope harness contract · API v1

Root: your NetScope checkout or installation directory.

Prefer `netscope.cmd` or `node --disable-warning=ExperimentalWarning cli.mjs`. All commands with `--json` write a single JSON object to stdout; `watch --json` writes NDJSON. Errors go to stderr as `{ok:false,error}`. Exit codes: 0 success, 1 failure, 2 invalid route. No stdin interaction for ordinary read/write commands. `system enable` may show a Windows UAC dialog.

CLI `status`, `doctor`, `watch` and `report` default to compact output: dense chart points and full adapter inventory are omitted. Use `--full` when needed. This keeps repeated agent tool results small; use filtered queries and small `records --limit` values when examining details. The HTTP API always returns its full documented response.

## Commands

| Command | Purpose |
|---|---|
| `help --json` | Machine-readable command index |
| `start`, `open`, `stop` | Background start, show desktop app, fully stop recording |
| `status --json`, `doctor --json` | Fresh collector, native sensor, storage and configuration state |
| `report --range all --json` | Four separate ranked lists, route totals, time series |
| `top --route direct --direction upload --json` | Direct upload ranking |
| `top --route direct --direction download --json` | Direct download ranking |
| `top --route vpn --direction upload --json` | VPN upload ranking |
| `top --route vpn --direction download --json` | VPN download ranking |
| `process --name codex.exe --json` | Process instances, destinations, route, bytes, timeline |
| `process --key KEY --route vpn --json` | Unambiguous program detail by key from `top` |
| `connections --route vpn --json` | Active sampled connections and speeds |
| `history --from ISO --to ISO --json` | Time series with adaptive buckets (minimum 1 minute) |
| `records --limit 500 --cursor CURSOR --json` | Paginated per-minute, per-process/endpoint details |
| `events --json` | Recent collection/configuration events |
| `watch --interval 5 --count 12 --json` | Bounded status stream; count 0 is unbounded |
| `export --format csv --out report.csv` | Program aggregate export (up to 1000 programs) |
| `export --format json --out report.json` | Same program aggregates in JSON |
| `config get --json` | Current settings and storage path |
| `config set --retention-days 90 --autostart on --effects off --json` | Validated settings; shortening retention immediately deletes expired production records |
| `config set --alerts on --hourly-gb 1 --json` | Desktop notification threshold for rolling-hour VPN upload + download; one-hour cooldown |
| `control pause`, `control resume`, `control compact` | Pause/resume recording, reclaim free database pages |
| `system enable`, `system disable` | Enable/disable privileged Windows ETW supplement |

Shared read options: `--range all|1h|24h|7d|30d`, `--from ISO_OR_EPOCH_MS`, `--to ISO_OR_EPOCH_MS`, `--route direct|vpn|proxy|all|unknown|transport`, `--search TEXT`. `top` additionally accepts `--limit` (1..1000) and `--offset`. Byte fields are decimal integer bytes; rates are bytes/s. Stored timestamps are UTC epoch milliseconds, UI displays local time. Range starts round down to the minute.

`records` returns `{rows,range,nextCursor}`. Pass `nextCursor` until it is null. Default page 500, maximum 5000. For stable exports while collection continues, freeze `--to` at a completed minute and reuse it across pages. Current-minute rows can grow while being read. This is the full-detail interface; program aggregate CSV intentionally remains compact.

## Interpretation rules

- `PROXY` means a non-DIRECT Clash route; this is a local estimate, not an airport invoice.
- `DIRECT` includes Clash DIRECT and verified Windows physical-route supplements.
- `UNKNOWN` stays separate. Do not assign it to VPN or direct by guessing.
- Core transport is not counted again in ETW. Physical adapter totals must never be added to application totals.
- Mihomo `metadata.type=Inner` is archived as `TRANSPORT`, named `代理核心内部连接`. Chain relay trackers can duplicate application bytes and do not contribute to Mihomo's global counters. Default queries, even `--route all`, exclude this accounting layer; four rankings and hourly alerts always exclude it. Core DNS/update tasks may also be Inner, so do not treat every internal byte as a proven duplicate. Physical counters remain independent.
- Inspect internal records with `top --route transport --json`, `connections --route transport --json`, `process --name 代理核心内部连接 --route transport --json`, or `records --route transport --json`. `--include-transport true` / HTTP `includeTransport=true` includes both layers for auditing only; never sum them as actual usage. `dashboard.internal` reports this separate layer, and `accountingNote` explains its scope.
- New record/destination fields `inboundType` and `attribution` retain the classification evidence. `clash-inner` is an observed Inner flag; `historical-proxy-chain-match` is a reviewed endpoint/chain inference for old records whose inbound type was not retained. Unknown program names do not imply unknown software exists on disk. Schema version 2 retains old minute bytes and adds flow evidence and separate quality internal counters.
- `clash-import` identifies the pre-application recorder. It lacks PID and exact protocol/port; zero PID is unknown, not the Windows idle process.
- Program grouping uses normalized executable path, falling back to process name. `key` is stable for that identity.
- A process can service multiple logical AI sessions. Process totals do not establish a particular conversation's traffic.
- TLS payloads and command-line secrets are not captured. Hostname and byte count do not prove the content of a request.
- Check `paused`, `lastSampleAt`, `systemLastAt`, `clashOnline`, `systemOnline`, `etwLost`, `error`, `systemError` before using current data.
- `quality` contains observed vs Clash global byte deltas. Global values include direct traffic and cannot be used as charged VPN traffic.

## Local HTTP

### Diagnostics in 1.1

New reads: `peaks`, `replay`, `compare`, `routes`, `route`, `trust`, `projects`, `rules`, `ai`, `probes`, `process-tree`, `bundle` under the existing `/api/v1/` base. Existing range/route/key/search filters apply where relevant. New byte fields retain the same integer-byte units.

- `peaks --direction upload --limit 12` returns minute totals. `replay --at ISO_OR_MS --minutes 5` returns processes, destinations and events, limited to 100 flows with an explicit truncation flag. `compare --from ISO --to ISO` defaults to the previous equally long window; optional `--baseline-from/--baseline-to` override it. Comparison windows are at most 31 days.
- `routes` provides retained `rule`, `rulePayload`, `inboundType`, `remoteDestination` and chain evidence. `route --flow-id ID` explains one record. Missing historical rule fields mean unavailable, not DIRECT. Schema 3 adds evidence columns without changing old bytes.
- `trust` separates unidentified programs, unclassified routes, sampling opportunities and byte counts. Expired history is excluded from gap detection. No percentage is a claim that the entire PC has been fully captured.
- `projects create --name NAME`; `projects bind --id ID --program KEY`, `--domain example.com`, or `--pid PID`. PID binding looks up the live creation time. `projects unbind --id RULE_ID` / `projects delete --id PROJECT_ID` remove preferences. HTTP mutations: `POST projects`, `DELETE projects?id=`, `POST project-rules {projectId,kind,value}`, `DELETE project-rules?id=`. Process-tree value is `{pid,started}`; no command lines or current-working-directory guesses are recorded. Overlapping project totals are explicit.
- `rules add --file rule.json`, `rules set --id ID --file rule.json`, `rules delete --id ID`; no subcommand lists rules and recent notifications. HTTP uses `POST/PATCH/DELETE rules` with `?id=` for update/delete. Fields: `name`, `kind` (`budget/spike/new-program/new-destination`), `programKey`, `route` (`PROXY/DIRECT/ALL`), `direction`, `period` (`hour/day/month`), `limitBytes`, `factor`, `enabled`. Only notifications; no traffic limits or blocking. Global notification switch and pause apply. Rule history and cooldown survive restarts.
- `ai` / `ai summary` reads request metadata; `ai scan` explicitly imports current local Codex compression logs; `config set --ai-diagnostics on|off` toggles automatic reads. `ai import --file metrics.jsonl` accepts at most 100 metadata rows. HTTP writes: `POST ai/scan {}` and `POST ai/metrics {metrics:[...]}`. No arbitrary source file is accepted over HTTP. SDK: `lib/ai-recorder.mjs`. `prepared` is not confirmed upload. Unknown image/retry fields remain unknown; request-body totals must not be added to traffic totals.
- `probe --host HOST --mode system|clash --count 3 --port 443 --tls on|off` actively contacts the chosen target. `GET probes` only reads history, `POST probes` performs a bounded test. Maximum 5 attempts and 10 seconds per attempt, default 5 seconds. DNS/TCP/TLS failures are recorded with stage/code. The CLI waits up to 65 seconds. System routing may traverse TUN; proxy mode does not invent remote DNS/TCP timings. Failure percentage is for connections, not packets.
- `bundle --range 1h --out diagnostic.json` exports a redacted evidence summary. Hostnames/IPs default to bundle-local aliases; paths, free-text events and session titles are absent. `--include-hosts true` explicitly retains hosts/IPs. At most 500 minute records; truncation is declared. Program names remain visible. Use narrower windows for model consumption.

### Stdio MCP

`netscope.cmd mcp-config --json` prints the actual local Node/`mcp.mjs` configuration without tokens or modifying any AI client. Launch Node directly, rather than feeding npm lifecycle banners to a protocol client. UTF-8 newline-delimited JSON-RPC only on stdout.

Default 13 read-only tools: `netscope_status`, `netscope_report`, `netscope_peaks`, `netscope_replay`, `netscope_compare`, `netscope_routes`, `netscope_explain_route`, `netscope_trust`, `netscope_projects`, `netscope_rules`, `netscope_ai_summary`, `netscope_probe_history`, `netscope_bundle`. `--allow-control` adds explicit pause/resume/compact, create-project and metadata-import operations; `--allow-probes` separately adds active connection testing. Nothing is automatically installed or enabled in the host. Bundle results default to 100 rows for MCP.

### Isolated acceptance

`NETSCOPE_DATA_DIR` selects a private database directory; `NETSCOPE_OFFLINE=1` serves retained history without starting Windows/Clash collectors. `tools/start-preview.mjs` creates an online backup in ignored `qa-output`, starts an isolated offline server on 47832 and prepares a metadata-only UI fixture. `tools/verify-v11-ui.js` is a visible Playwright CLI acceptance script for that preview; never run its preference mutations against the production port. Stop the preview through its authenticated API when finished.

Base: `http://127.0.0.1:47831/api/v1/`. No LAN binding or external network dependency. Routes: `GET status`, `dashboard`, `programs`, `program`, `connections`, `history`, `records`, `events`, `settings`, `export`. Query parameters mirror CLI names (HTTP routes use `DIRECT`, `PROXY`, `UNKNOWN`, `ALL`; sorting is `sort=upload|download|total`).

`PATCH settings` accepts only `retentionDays` (0..3650), `autoStart`, `effects`, `paused`, `alertEnabled` `alertHourlyGB` (0.1..100000) and `aiDiagnosticsEnabled`. `POST control` accepts `{action}` with `pause`, `resume`, `compact`, `system-enable`, `system-disable`, `stop`. Mutation requests need `Content-Type: application/json` and `X-NetScope-Key` read from `data/api-token`. Do not print or publish that token. Host/Origin and cross-site fetch checks reject web-origin misuse. No arbitrary shell commands, SQL execution, filesystem paths or network URLs are accepted by mutation endpoints.

For Node clients use `fetch` against the loopback base. If a tool automatically proxies local addresses, disable proxy use for 127.0.0.1. Do not change the user's global proxy configuration.

## Persistence and operations

`data/traffic.sqlite` uses WAL. Do not copy only the main SQLite file while it is writing; use SQLite online backup or stop recording first. Do not write the database while the app is running; use the API. On disk, `actors` and `flows` normalize identities; `traffic` stores minute totals with a composite key and time/flow indexes. Cleanup runs every 15 minutes and on retention changes. The earliest retained time is `storage.firstMs`, which can differ from original `recordingSince` after cleanup.

Desktop executable: `desktop/NetScope.exe`; `--background` starts in the tray; `--hide` hides the existing window; `--verify-ui` captures its WebView content, native title bar and DOM diagnostics to `qa-output`. The borderless native title bar provides Background (hide to tray; keep recording), Maximize/Restore, and Close (stop recording then exit). Alt+F4 follows Close. Drag the empty title area to move the window; double-click to maximize/restore. `--verify-chrome` exercises Background and Maximize/Restore, title single/double-click behavior, activation/nonclient-paint interception, native caption absence, and resize hit tests, and writes `qa-output/desktop-chrome.json`; it leaves the app open and does not exercise Close. Tray Exit and CLI `stop` also stop the recorder. Desktop startup shortcut is `墨流 NetScope.lnk` in the user's Startup folder. Optional ETW task is `NetScope Network Sensor (<user-id>)`. Normal UI/backend remain non-admin. Source and compiled sensor files must remain alongside the desktop directory; moving the whole installation requires refreshing startup/ETW registration paths.

This app records and visualizes usage, with optional desktop-only threshold notifications. It does not block network traffic or kill applications. `status.alert` and `events` expose alert evidence; desktop notification IDs persist to avoid repeat alerts across restarts.
