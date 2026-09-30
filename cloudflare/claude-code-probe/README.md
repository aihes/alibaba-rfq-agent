# Cloudflare GLM service and Claude Code probe

This Worker exposes authenticated agent and OCR APIs while retaining the earlier
fixed Claude Code probe. Claude Code is the agent runtime; its model backend is
GLM, not an Anthropic-hosted Claude model. API keys stay in Cloudflare secrets; the RFQ desktop app
uses these remote APIs by default. It is deployed at `https://glm.knowflow.work/` and
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
starting the container. The model key stays in the Worker runtime. Cloudflare's
container outbound handler intercepts model requests and adds the key outside
the container. Claude Code receives only a non-secret placeholder token. Model
egress is limited to the Messages endpoint, the selected model, 40 calls per
run, and 32,000 output tokens per call. The legacy probe uses the same pattern
with its separate key. Neither key is placed in the container environment or
a response.

The desktop app saves its client token in encrypted local settings.

## Service API

All requests use HTTPS and JSON. The service is currently for the owner's use:
both APIs require a client token. The service stores only its SHA-256 hash and
can revoke it. Never bundle `PROBE_TOKEN`, `GLM_API_KEY`, or
`SERVICE_GLM_API_KEY` in an installer. If the desktop app is distributed later,
issue a distinct client token for each installation. The desktop app accepts the
token under Settings → Model service; cloud OCR reuses it.

`POST /v1/agent` accepts a `query`, an optional `session_id`, an optional
`skill`, and up to two `images`. The default skill is `rfq-quote-advisor`,
bundled from `src/skills/rfq-quote-advisor/SKILL.md` in this repository and
installed as a native Claude Code project Skill before each run. Set
`"skill":null` for a general request. Clients cannot upload or modify Skills
through this API. Claude Code can use its built-in tools, including Bash,
file operations, web tools, and the Skill tool, for up to 20 turns in one
request. The Worker forwards the query and original image blocks directly to
Claude Code. It does not run OCR or assemble its own conversation history for
this route. New text-only sessions use GLM-5.3; requests with images use
GLM-5.3-Flash. Once a session has received an image, it stays on Flash so
follow-up turns can use its visual context. The response contains `answer`,
`session_id`, `model`, `skill`, `tools_used`, `image_handling`, `image_count`,
and `quota_remaining`. `tools_used` lists tool names observed in Claude Code's
stream output; it is empty when a request does not call a tool. A Skill invoked
through its slash command can be expanded before a `Skill` tool event, so its
name need not appear in `tools_used` even when its instructions were loaded.
Sessions are scoped to the client token. Claude Code's own `--session-id` and
`--resume` handle continuity; the Worker saves its transcript in Durable Object
storage so it can be restored after the container sleeps. A request changes
the native session if it switches between RFQ and general mode. Each Agent
call uses an ephemeral workspace and destroys its container afterward, so
files written by tools do not persist across API calls. Transcript context
does persist. The upstream GLM compatibility layer may not support every
Claude Code tool; verify each tool against the deployed service.

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

Agent queries can contain up to 50,000 characters. Images must contain actual
PNG or JPEG bytes, at most 3 MiB each. Base64 data
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
remote API paths; desktop integration is tested separately.
The legacy fixed prompt was also retested after the shared-container change
and returned `GLM_REMOTE_OK`.

On 2026-09-30, the updated Worker used a native project Skill bundled from this
repository and enabled Claude Code's built-in tools with a 20-turn limit. The
deployed service returned `REMOTE_AGENT_OK` across two calls to one session,
used Bash to write and read `RFQ_TOOL_OK`, loaded the RFQ Skill's specific
`riskFlags` guidance, used WebFetch to read the title `Example Domain`, and
read `RFQ OCR 456` directly from a PNG using `glm-5.3-flash`. The authorized
legacy probe returned `GLM_REMOTE_OK`; an unauthorized probe returned 401.
These checks verify the named tools and image path, not every Claude Code tool.

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

## 管理后台（Cloudflare Access）

源码：`src/admin-page.js`（页面）、`src/admin-auth.js`（登录校验）、`src/index.js`（路由/持久化）。
入口 `https://glm.knowflow.work/admin`，支持分页列表、搜索已加载记录、签发、修改备注和每日额度、撤销。
完整令牌只在创建时显示一次，列表不返回令牌或哈希。撤销不可恢复，补发需创建新令牌。
修改额度不清零用量；用量按 UTC 日重置，全服务每日共享上限仍为 Agent 100 / OCR 500。

上线配置：
1. Cloudflare Zero Trust → Access → Applications 新建 Self-hosted 应用，保护
   `glm.knowflow.work/admin` 及所有子路径，确认 `/admin/api/clients` 同样被保护。
   不要保护整个域名，避免拦截桌面客户端 `/v1/agent`、`/v1/ocr`。
2. 开启 One-time PIN 登录，Allow 策略仅含 `aihehe123@gmail.com`，不要配置 Everyone 或 Bypass。
3. Worker 配置 `ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com`（无尾斜杠）、
   `ACCESS_AUD=<Access 应用 AUD>`、`ADMIN_EMAILS=aihehe123@gmail.com`。
   将配置同步到 Wrangler vars 或部署配置，避免后续部署覆盖 Dashboard 配置。
4. 部署后验证匿名登录跳转、其他邮箱拒绝、管理员增发/编辑/撤销测试令牌。
   检查另一个自定义域名和 workers.dev 上的后台也不能匿名访问。

缺配置返回 503，无效/缺失 JWT 返回 401，非管理员邮箱返回 403。
Worker 验证 JWT 的 RS256 签名、issuer、audience、有效期、邮箱；写入还检查同源 Origin 和自定义头。
后台不使用或暴露 PROBE_TOKEN；原 `/v1/admin/clients` 管理脚本继续使用管理员密钥。
本地测试不代表线上 Access 配置或真实邮箱登录已通过验收。
