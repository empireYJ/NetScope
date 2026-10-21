# Contributing

NetScope currently targets Windows. Keep the local-only architecture, separate accounting layers and evidence-based attribution intact.

1. Open an issue describing the problem or proposed behavior. Include versions and reproducible steps; use synthetic fixtures or redacted diagnostic bundles.
2. Create a branch, make a focused change, and update the CLI/API contract when fields or behavior change.
3. Run `npm test` and `npm run build` on Windows. Tests must use isolated temporary data, never your production database. Desktop, UAC, notifications and startup integration need separate manual validation when changed.
4. Submit a pull request with the behavior change, relevant validation and remaining limitations.

Do not commit databases, captures, credentials, subscriptions, user logs, exports, WebView profiles, binaries or personal network screenshots. Do not derive DIRECT/PROXY attribution from an unverified hostname or count internal transport twice.

MCP stdout must contain only newline-delimited JSON-RPC. New write operations require the existing local authorization checks; active network probes remain explicitly opt-in.

The Node, PowerShell and C# identity helpers share the same lowercase-username UTF-8 SHA-256 prefix. Keep these formats synchronized when changing per-user pipe or mutex identifiers.
