# Cloudflare GLM service and Claude Code probe

This Worker exposes authenticated agent and OCR APIs while retaining the earlier
fixed Claude Code probe. API keys stay in Cloudflare secrets; the RFQ desktop app
has not yet been switched to these remote APIs. It is deployed at `https://glm.knowflow.work/` and
`https://claude-probe.knowflow.work/` on the account with Containers access.

The Worker uses the public `node:22-slim` image. On the first authorized
request of each container lifetime, it installs the pinned Anthropic Claude Code
npm package and runs a version check. `GET /version` returns that version.
`POST /test-model` runs a fixed prompt through `GLM-5.3[1m]` using the same
Anthropic-compatible endpoint configured locally. It disables Claude's tools
and session persistence. The legacy probe and Agent API share one container
instance because this deployment allows only one running instance. The Worker
stops the container after a completed Claude Code call; a 45-second idle sleep
is a fallback. Each cold start installs the package again because the
container filesystem is ephemeral.

`PROBE_TOKEN`, `GLM_API_KEY`, and `SERVICE_GLM_API_KEY` must be configured as
Cloudflare Worker secrets. `SERVICE_GLM_API_KEY` is a standard API key used
with `api.z.ai` for Claude Code and `open.bigmodel.cn` for GLM-OCR. It is
separate from the personal Coding Plan key used by the older probe. The
service key is used for GLM-5.3, GLM-5.3-Flash, and GLM-OCR.
Do not commit or print them. The root route only reports Worker readiness;
both legacy probe routes require `Authorization: Bearer <PROBE_TOKEN>` before
starting the container. The model key is passed to the Claude process as an
environment variable for that invocation and is never placed in command
arguments or a response.

The current RFQ desktop app invokes a local Claude executable and does not yet
call this Worker.

## Service API

All requests use HTTPS and JSON. The service is currently for the owner's use:
both APIs require a client token. The service stores only its SHA-256 hash and
can revoke it. Never bundle `PROBE_TOKEN`, `GLM_API_KEY`, or
`SERVICE_GLM_API_KEY` in an installer. If the desktop app is distributed later,
issue a distinct client token for each installation.

`POST /v1/agent` accepts a `query`, an optional `session_id`, and up to two
`images`. The Worker forwards the query and original image blocks directly to
Claude Code. It does not run OCR or assemble its own conversation history for
this route. New text-only sessions use GLM-5.3; requests with images use
GLM-5.3-Flash. Once a session has received an image, it stays on Flash so
follow-up turns can use its visual context. The response contains `answer`,
`session_id`, `model`, `image_handling`, `image_count`, and `quota_remaining`.
Sessions are scoped to the client token. Claude Code's own `--session-id` and
`--resume` handle continuity; the Worker saves its transcript in Durable Object
storage so it can be restored after the container sleeps.

```http
POST /v1/agent
Authorization: Bearer <client-token>
Content-Type: application/json

{"session_id":"case-123","query":"请分析这条询盘缺少哪些规格","images":[{"mime_type":"image/png","data":"<base64>"}]}
```

`POST /v1/ocr` recognizes one PNG or JPEG image and returns `status`, `text`,
`model`, `provider_request_id`, and `quota_remaining`.

```http
POST /v1/ocr
Authorization: Bearer <client-token>
Content-Type: application/json

{"image":{"mime_type":"image/png","data":"<base64>"}}
```

Images must contain actual PNG or JPEG bytes, at most 3 MiB each. Base64 data
URIs are also accepted. URLs are not accepted. The maximum JSON request body
is 9 MiB. Client limits default to 20 agent calls and 100 OCR images per UTC
day, with bursts capped at 3 agent calls and 10 OCR images per minute. Agent
images count only toward the Agent limit; `/v1/ocr` has its own OCR limit. The
whole service also stops at 100 agent
calls and 500 OCR images per UTC day. A request exceeding a limit returns HTTP 429.
Responses never include either upstream API key.

An administrator calls `POST /v1/admin/clients` with
`Authorization: Bearer <PROBE_TOKEN>` and JSON such as
`{"name":"owner-test","daily_agent_limit":20,"daily_ocr_limit":100}`.
The response returns the client token **once**. The administrator can revoke
it with `DELETE /v1/admin/clients/<client_id>` using the same admin header.

The server stores Claude Code's native session transcript in Cloudflare Durable
Object storage, with a 32 MiB transcript limit per session. After seven days
without activity, the next successful call starts a new session. This is not
yet a timed data deletion policy: an inactive transcript is removed on that
next successful call, and revoking a client token does not automatically
delete its transcripts.
This API does not submit quotations or operate the Alibaba browser.

From this directory, `npm run client:create -- owner-test` creates a private
owner test token at `../../tmp/remote-client-token` (mode 0600). The admin
token must already exist at `../../tmp/claude-probe-token`. Run
`npm run test:service` for a two-turn agent check. Pass a PNG/JPEG path after
`--` to also check both OCR and agent image handling, for example
`npm run test:service -- ../../tmp/ocr-sample.png`. To issue another client
token, provide a distinct name and output file to `client:create`.

On 2026-09-29, the deployed service returned HTTP 401 without a client token.
An authenticated two-turn Agent request reused its session ID and replied
`REMOTE_AGENT_OK` on both turns. OCR recognized `RFQ OCR 456` from a synthetic
PNG. After the direct-Claude change, a text session resumed and replied
`TEST_OK`, and a direct image call replied `456` using `glm-5.3-flash` with
`image_handling: claude-code-direct`. A text session switched to Flash when an
image was added. The container then stopped, and another follow-up restored
the native Claude Code transcript and replied `456`. A newly created token
returned HTTP 401 after the administrator revoked it. These checks prove the
remote API paths;
they do not mean the desktop application has been integrated or tested with them.
The legacy fixed prompt was also retested after the shared-container change
and returned `GLM_REMOTE_OK`.

On 2026-09-29, public `GET /` returned `worker-ready`, unauthenticated
`GET /version` returned HTTP 401, and the authorized version check returned
`2.1.284 (Claude Code)`. The Cloudflare instance was then read back as
`inactive`. The local probe token is in the Git-ignored `tmp/claude-probe-token`
file with mode 0600 and is also stored as the Worker's `PROBE_TOKEN` secret.

After configuring `GLM_API_KEY` from the local Claude settings as a Cloudflare
secret, an unauthorized `POST /test-model` returned HTTP 401 and an authorized
call returned HTTP 200 with `GLM_REMOTE_OK` from `GLM-5.3[1m]`. The Cloudflare
container instance was read back as `inactive` after the request.

On 2026-09-29, `glm.knowflow.work` was added as a second Cloudflare Custom
Domain. Cloudflare's authoritative DNS and public resolvers returned its
records; HTTPS `GET /` returned 200 on both domains. On the new domain,
unauthorized `POST /test-model` returned 401 and the authorized fixed prompt
returned `GLM_REMOTE_OK`. The model container was then read back as `inactive`.
The public root route is only a health check; this probe is not yet a chat
interface for classmates. Keep the probe token private.

## Test the deployed Worker

From this directory, run `npm run test:remote`. The script uses the local
Git-ignored `../../tmp/claude-probe-token` file, or `PROBE_TOKEN` from the
process environment. It checks the public health route, verifies that an
unauthorized model request is rejected, and makes one real fixed-prompt GLM
request. It never prints the token. A cold container may take longer because
Claude Code is installed again.

Run `npm run test:remote -- --health-only` to check the public route without a
token or a model call. The legacy `/test-model` route accepts only its fixed
prompt; `/v1/agent` accepts custom queries for provisioned clients.
