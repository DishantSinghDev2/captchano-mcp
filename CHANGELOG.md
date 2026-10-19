# Changelog

All notable changes to `captchano-mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-19

### Added

- First release of the CaptchaNo MCP server.
- Tools: `solve_captcha`, `get_task`, `get_balance`, `list_captcha_types`.
- Supported types: `recaptcha_v2`, `recaptcha_v3`, `recaptcha_enterprise`, `turnstile`, `datadome`, `image`.
- `solve_captcha` blocks on `POST /v1/solve?wait=N` and, when the API answers 202, polls
  `GET /v1/task/{id}` every 5 s for up to 120 s in total. If it is still solving, the call returns the task id
  so the agent can resume with `get_task`.
- Per-type argument validation before any request is sent, so bad arguments are never billed.
- API errors become `isError` tool results with the error code, the message and a hint for what to do next.
- `CAPTCHANO_MAX_SPEND_USD`: an optional spend ceiling for each process, based on the `cost` the API returns.
- Structured output (`outputSchema` + `structuredContent`) and tool annotations on every tool.
- Transports: stdio (default) and stateless Streamable HTTP (`--http`), with optional bearer-token protection
  (`CAPTCHANO_MCP_HTTP_TOKEN`).
- Progress notifications while polling, when the client sends a progress token.
- Serves both the 2025-era and the 2026-07-28 MCP protocol revisions (MCP TypeScript SDK v2).
- Logs go to stderr only. API keys, bearer tokens and proxy credentials are removed from log lines.
- Packaging: npm (`npx -y captchano-mcp`), MCP Registry `server.json`, MCPB `manifest.json`, Dockerfile,
  `glama.json`.
