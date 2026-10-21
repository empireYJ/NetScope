# Security and privacy

NetScope is a local Windows diagnostic application. The HTTP server binds only to loopback, validates Host/Origin and requires the local `data/api-token` for mutations. Do not expose its port through a reverse proxy or to a LAN. It is not a multi-user remote service.

Local HTTP reads and stdio MCP can reveal program and network metadata. Only connect trusted clients. MCP is read-only by default; control and active probes require separate startup options. The optional Windows sensor runs with administrator privileges to observe ETW events.

Never share raw databases, tokens, proxy configuration, subscriptions, logs, diagnostic exports or WebView profiles without reviewing them. The default diagnostic bundle redacts host identifiers and paths, but deliberately retains program names. Sanitization is not a guarantee that an export is suitable for every audience.

For a suspected vulnerability, use the repository's **Security → Report a vulnerability** private reporting feature if available. If it is unavailable, open an issue requesting a private contact without publishing exploit details, tokens or personal data. Private vulnerability reporting may need to be enabled by the repository maintainer.

This project is maintained on a best-effort basis and currently has no guaranteed security support period. Updates should be reviewed before installation, particularly changes to the elevated sensor, authentication, local pipes and data export logic.
