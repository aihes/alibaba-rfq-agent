# Cloudflare Claude Code deployment probe

This isolated Worker verifies that Claude Code can start inside a Cloudflare
Container. It does not accept prompts, run arbitrary commands, contain a model
API key, or connect the RFQ desktop app to a remote service. It is deployed at
`https://claude-probe.knowflow.work/` on the account with Containers access.

The Worker uses the public `node:22-slim` image. On the first authorized
`GET /version` request of each container lifetime, it installs the pinned
Anthropic Claude Code npm package, runs `claude --version`, and returns that
version. The Worker destroys the container after the check, with 45-second idle
sleep as a fallback. Each cold start installs the package again because the
container filesystem is ephemeral.

`PROBE_TOKEN` must be configured as a Cloudflare Worker secret. Do not commit
or print it. The root route only reports Worker readiness; `/version` requires
`Authorization: Bearer <token>` before starting the container.

This is an installation and remote process test. Model inference requires an
account or provider Key and a separate authenticated request contract. The
current RFQ desktop app invokes a local Claude executable and does not call
this Worker.

On 2026-09-29, public `GET /` returned `worker-ready`, unauthenticated
`GET /version` returned HTTP 401, and the authorized version check returned
`2.1.284 (Claude Code)`. The Cloudflare instance was then read back as
`inactive`. The local probe token is in the Git-ignored `tmp/claude-probe-token`
file with mode 0600 and is also stored as the Worker's `PROBE_TOKEN` secret.
