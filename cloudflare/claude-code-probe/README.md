# Cloudflare Claude Code deployment probe

This isolated Worker verifies that Claude Code can start inside a Cloudflare
Container and make one fixed GLM inference request. It does not accept arbitrary
prompts or commands, contain an API key in source, or connect the RFQ desktop app
to a remote service. It is deployed at
`https://claude-probe.knowflow.work/` on the account with Containers access.

The Worker uses the public `node:22-slim` image. On the first authorized
request of each container lifetime, it installs the pinned Anthropic Claude Code
npm package and runs a version check. `GET /version` returns that version.
`POST /test-model` runs a fixed prompt through `GLM-5.3[1m]` using the same
Anthropic-compatible endpoint configured locally. It disables Claude's tools
and session persistence. The Worker destroys the container after each check,
with 45-second idle sleep as a fallback. Each cold start installs the package
again because the container filesystem is ephemeral.

`PROBE_TOKEN` and `GLM_API_KEY` must be configured as Cloudflare Worker secrets.
Do not commit or print them. The root route only reports Worker readiness;
both probe routes require `Authorization: Bearer <token>` before starting the
container. The key is passed to the Claude process as an environment variable
for that invocation and is never placed in command arguments or a response.

This is an installation and fixed-inference test. The current RFQ desktop app
invokes a local Claude executable and does not call this Worker.

On 2026-09-29, public `GET /` returned `worker-ready`, unauthenticated
`GET /version` returned HTTP 401, and the authorized version check returned
`2.1.284 (Claude Code)`. The Cloudflare instance was then read back as
`inactive`. The local probe token is in the Git-ignored `tmp/claude-probe-token`
file with mode 0600 and is also stored as the Worker's `PROBE_TOKEN` secret.

After configuring `GLM_API_KEY` from the local Claude settings as a Cloudflare
secret, an unauthorized `POST /test-model` returned HTTP 401 and an authorized
call returned HTTP 200 with `GLM_REMOTE_OK` from `GLM-5.3[1m]`. The Cloudflare
container instance was read back as `inactive` after the request.
