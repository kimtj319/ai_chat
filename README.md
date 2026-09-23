# Qwen3 Web Chat

A web chat app for self-hosted model servers: Vite + React 19 + TypeScript
frontend, backed by a Node/Express **server** that talks to the serving
endpoints, persists conversations as JSON files on disk, and runs tool calls on
the model's behalf. The browser never talks to a model server directly — no
CORS, no API key on the client.

You point it at your own serving endpoints; the models behind them need not all
be chat models, because the app **measures** what each one can do and routes the
turn accordingly (see "Model capabilities"). Everything under `/api` except the
four auth routes requires a signed-in, admin-approved account (see "Accounts").

## Configuration — 어떤 키를 어디에 넣는가

설정은 전부 **`web/.env`** 한 파일에 들어간다. 저장소에는 `.env.example` 만
들어 있고 `.env` 는 `.gitignore` 에 있으므로, 실제 키가 커밋될 일은 없다.

```bash
cp .env.example .env      # 그리고 아래 표를 보며 필요한 값만 채운다
```

`.env` 의 값보다 **실제 환경변수가 항상 우선**한다. 컨테이너로 띄울 때는
환경변수로 주고 `.env` 를 아예 두지 않아도 된다.

### 없으면 앱이 뜨지 않는 것

| 키 | 무엇 | 없으면 |
|---|---|---|
| `VLLM_ENDPOINTS` 또는 `VLLM_BASE_URL` | 모델을 서빙하는 OpenAI 호환 서버 주소. `/v1` 까지 적는다 | 기본값 `http://localhost:8000/v1` 로 붙으려다 실패하고, 모델 목록이 빈 채로 뜬다 |

`VLLM_ENDPOINTS` 는 `라벨|주소|키?` 를 쉼표로 이어 여러 개를 적는다. 키는
**엔드포인트마다** 다를 수 있어 세 번째 칸에 싣는다:

```
VLLM_ENDPOINTS=Local|http://localhost:8000/v1,Gateway|https://gateway.example.com/v1|sk-your-key-here
```

게이트웨이(LiteLLM 등)는 대개 키를 요구하며, 없으면 401 을 돌려준다. 모든
엔드포인트에 같은 키를 쓴다면 `VLLM_API_KEY` 하나로 갈음해도 된다.

### 첫 관리자 계정 — 처음 한 번만

가입은 누구나 할 수 있지만 **관리자가 승인해야** 로그인된다. 그 첫 관리자는
아래 두 값으로 만들어진다.

| 키 | 무엇 |
|---|---|
| `ADMIN_ID` | 첫 관리자 아이디 |
| `ADMIN_PASSWORD` | 그 비밀번호 (평문으로 적는 유일한 자리) |

계정이 만들어진 **다음부터는 이 값을 읽고 무시**한다. 그러니 한 번 뜬 뒤에는
`.env` 에서 두 줄을 지워라 — 비밀번호를 바꾸는 것은 앱 안에서 한다. 저장되는
것은 scrypt 해시(N=32768, r=8, p=1)다.

### 넣으면 기능이 켜지고, 없으면 그 기능만 조용히 빠지는 것

없다고 앱이 죽지 않는다. 해당 기능이 **아예 나타나지 않는다** — 실패하는
버튼을 보여 주는 것보다 낫다는 판단이다.

| 키 | 켜지는 것 | 발급처 |
|---|---|---|
| `TAVILY_API_KEY` | `web_search` 도구 | <https://tavily.com> |
| `ALPHAVANTAGE_API_KEY` | 주가·환율 MCP 서버 | <https://www.alphavantage.co> |
| `GITLAB_TOKEN` + `GITLAB_MCP_URL` | GitLab 이슈 조회 MCP 서버 | GitLab → Settings → Access Tokens (읽기 전용, project-scoped 로 충분) |
| `RAG_MCP_URL` | 업로드한 문서를 검색하는 RAG MCP 서버 | 자체 운영하는 SF-1 RAG MCP 주소 |
| `MCP_IDENTITY_TOKEN` | MCP 서버에 "누가 물었는지" 를 전달 | 그 MCP 서버와 미리 나눠 가진 값 |
| `MODEL_ADMIN_TOKEN` | 서빙 엔드포인트 등록·삭제를 이 토큰 소지자로 제한 | 직접 정한 임의의 긴 문자열 |

`web_search` 는 특히 주의할 것: 키가 없어도 도구 목록에는 보이고, 웹이 필요한
질문이 나오기 전까지 아무 일도 일어나지 않는다. "웹 검색이 안 된다" 면 여기부터
확인하라.

### 모델이 추론 설정을 어떻게 받아들이는지

| 키 | 무엇 |
|---|---|
| `REASONING_PROFILES` | `패턴=fixed` 또는 `패턴=budget[:최소값]` 을 쉼표로 이은 것 |

모델마다 추론 관련 필드를 대하는 태도가 다르다. 어떤 게이트웨이는 모르는
필드에 400 을 내고, 어떤 모델은 받아들이고 무시한다. 그것은 **서빙하는 쪽
사정**이라 코드가 아니라 배포가 안다.

```
REASONING_PROFILES=some-model=fixed,other-model=budget:256
```

- `fixed` — 사용자가 고를 것이 없는 모델. 추론 필드를 아예 보내지 않는다.
- `budget:N` — 생각 예산으로 조절하되 N 아래로는 내리지 않는다. 너무 낮은
  예산은 생각을 줄이는 대신 **답변을 길게** 만들어, 원하던 것과 반대가 된다.

비워 두면 모든 모델이 기본값(`budget:128`)을 쓴다. 알아볼 수 없는 항목은
기동 로그에 남는다 — 오타 하나가 그 모델의 추론 방식을 바꾸는데 달리 알 길이
없기 때문이다.

`MODEL_ADMIN_TOKEN` 을 비워 두면 **로그인한 아무 계정이나** 서빙 엔드포인트를
등록할 수 있다. 그것은 서버가 그 사람이 고른 주소로 접속하게 만들고, 남의
대화가 그리로 흘러갈 수 있다는 뜻이다. 계정을 전부 믿을 수 있는 게 아니라면
반드시 설정하라.

### 키가 새지 않게 해 둔 것

- 브라우저는 모델 서버와 **직접 말하지 않는다.** 모든 호출이 이 백엔드를
  거치므로 키가 클라이언트로 내려가지 않는다.
- Alpha Vantage 처럼 키를 쿼리 문자열로 받는 서버는, `/api/mcp/servers` 가
  URL 에서 쿼리를 **떼고** 보고한다.
- `.env` 는 `.gitignore` 에 있고, 서버에서는 mode 600 으로 두기를 권한다.

## Install

```bash
npm install
```

## Run (development)

Two dev servers, in two terminals:

```bash
npm run dev:server   # Express backend on :8080 (tsx watch, auto-restarts on server/** changes)
npm run dev           # Vite dev server on :5173, proxies /api/* -> :8080
```

Open `http://localhost:5173`.

## Run (production-style, one process)

```bash
npm run build          # tsc --noEmit + vite build -> dist/
npm run build:server   # tsc -p server/tsconfig.json -> dist-server/
npm run start           # node dist-server/index.js — serves dist/ AND /api/*
```

Or use the control script, which does all of the above and backgrounds the
process (see below):

```bash
./start_web.sh start
```

## `start_web.sh`

Modeled on the project's `../qwen-serving.sh` (same house style/messages).

```bash
./start_web.sh start     # build if needed, start detached, poll /api/health, print URL
./start_web.sh status    # running/stopped, pid, uptime, port, /api/health, vLLM reachability, last 5 log lines
./start_web.sh logs      # tail -f today's log
./start_web.sh stop      # graceful TERM, then KILL if it doesn't exit
./start_web.sh restart   # stop + start
```

State lives under `web/run/web.pid` and `web/log/YYYYMMDD.log` (both
gitignored). It reads `PORT` / `VLLM_BASE_URL` from `.env` if present;
environment variables you export before invoking it win over `.env`.

## Config

Copy `.env.example` to `.env` and adjust. All variables:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port the Express server listens on |
| `VLLM_ENDPOINTS` | `local\|http://localhost:8000/v1` | Comma-separated `label\|baseUrl\|apiKey?` serving endpoints. A gateway usually **requires its key** — it answers 401 without one — so the key rides on the entry itself rather than in `VLLM_API_KEY` |
| `VLLM_BASE_URL` | `http://localhost:8000/v1` | Single-endpoint fallback, used only when `VLLM_ENDPOINTS` is unset |
| `VLLM_API_KEY` | (empty) | Optional bearer token, for endpoints that do not carry their own |
| `MODEL_CAPABILITY_PROBE` | `1` | Probe each newly seen model once to find out what it can do; `0` skips the probes and lists whatever `/v1/models` said |
| `DATA_DIR` | `./data` | Where session/conversation JSON files are written |
| `TOOL_FETCH_ALLOWLIST` | (empty = any public host) | Comma-separated hostnames `http_fetch` may access |
| `TOOL_FS_ROOT` | `.` (the `web/` dir) | Root directory `read_text_file`/`list_directory` may read from |
| `TOOL_MAX_ROUNDS` | `0` (unlimited) | Hard cap on tool-calling rounds per turn; the context budget ends the loop instead |
| `TOOL_TIMEOUT_MS` | `10000` | Hard cap on one tool call; the runner aborts it and the model answers around the timeout. Values under 1000 are ignored |
| `TOOL_HTTP_TIMEOUT_MS` | `10000` | Timeout for one outbound HTTP request made by a tool; the two-leg tools (`weather_lookup`, `wikipedia_lookup`) give each leg 60% of it. `TOOL_TIMEOUT_MS` is still the outer bound |
| `TOOL_MAX_RESULT_BYTES` | `102400` | How much of one tool result reaches the model; the rest is truncated. Raising it makes each research round cost more of the context window |
| `TAVILY_API_KEY` | (empty) | API key for the `web_search` tool ([tavily.com](https://tavily.com)). Without it `web_search` fails with a "not configured" error and every other tool keeps working — so the gap is invisible until someone asks something that needs the web |
| `TAVILY_API_URL` | `https://api.tavily.com/search` | Where `web_search` sends its query; only for a Tavily-compatible proxy or mirror, since the request shape and bearer header are Tavily's |
| `CONTEXT_TOOL_STOP_RATIO` | `0.8` | Once the prompt fills this share of the context window, stop offering tools and answer |
| `CONTEXT_COMPACT_RATIO` | `0.7` | Once the prompt fills this share of the window while tools are still offered, summarise the turn's older research into one interim report and rebuild the context around it instead of truncating tool results. `0` disables it; must stay below `CONTEXT_TOOL_STOP_RATIO` (clamped with a warning otherwise) |
| `CONTEXT_KEEP_RECENT_RATIO` | `0.15` | How much of the window compaction leaves un-summarised: the most recent tool exchanges (an `assistant(tool_calls)` message with its results) stay verbatim while their combined token count fits under this share, and only older ones become the report. Keep it well below `CONTEXT_COMPACT_RATIO` — at or above it nothing is old enough to summarise and compaction reports it has nothing to gain |
| `CONTEXT_MAX_COMPACTIONS` | `2` | How many times one turn may compact; once spent, the prompt grows again and `CONTEXT_TOOL_STOP_RATIO` ends the loop |
| `NORMAL_MODE_DEADLINE_MS` | `1800000` (30 min) | SAFETY-NET ceiling on thinking time in **normal** reasoning mode, for a turn nobody is watching any more: when it passes, the turn is stopped and the model writes its answer from the reasoning it already produced. **External** mode ignores it. This used to be the primary way a normal-mode turn ended early, enforced unconditionally at 3 minutes — that is now the person's own "지금 답변하기" click (`ANSWER_NOW_THRESHOLD_MS` below), in both modes, so this only has to catch an unattended tab. Values under 1000 are ignored |
| `ANSWER_NOW_THRESHOLD_MS` | `180000` (3 min) | How long a turn may run before the client offers "지금 답변하기" (answer now) above the composer — mode-agnostic, unlike `NORMAL_MODE_DEADLINE_MS` above. Clicking it stops the current model call and moves the turn to the same wrap-up call, built from the reasoning and tool results already gathered. Values under 1000 are ignored |
| `MODEL_ENDPOINTS_FILE` | (empty) | Path to the endpoints file; empty uses the lookup order `./.model`, then `{DATA_DIR}/.model` |
| `MODEL_ADMIN_TOKEN` | (empty) | Secret required by `POST`/`DELETE /api/models/endpoints` (`X-Model-Admin-Token`). Empty = anyone can add/remove endpoints — see the warning below |
| `ATTACHMENT_MAX_IMAGE_BYTES` | `10485760` | Largest image accepted (transport limit) |
| `ATTACHMENT_MAX_TEXT_BYTES` | `2097152` | Largest text file accepted; above this the upload is refused with 413 |
| `ATTACHMENT_INLINE_TEXT_BYTES` | `32768` | Text at or below this is inlined into the prompt; above it a stub + `read_attachment` |
| `ATTACHMENT_MAX_PER_MESSAGE` | `6` | Attachments per message |
| `ATTACHMENT_MAX_MESSAGE_BYTES` | `26214400` | Combined bytes per message |
| `ATTACHMENT_MESSAGE_TOKEN_RATIO` | `0.25` | Share of **that conversation's model's** window all attachments of one message may cost (0.25 x 262144 = 65,536); one file may not exceed half of it |
| `ATTACHMENT_DEFAULT_MESSAGE_TOKENS` | `65536` | Fallback budget when a model reports no window |
| `ATTACHMENT_MAX_PER_CONVERSATION` | `20` | Stored attachments per conversation |
| `ATTACHMENT_MAX_CONVERSATION_BYTES` | `104857600` | Stored bytes per conversation |
| `ATTACHMENT_MAX_SESSION_BYTES` | `524288000` | Stored bytes per **account** (the variable keeps its old name so deployed `.env` files keep working) |
| `ATTACHMENT_UPLOADS_PER_MINUTE` | `30` | Upload rate limit per account (429) |
| `ATTACHMENT_MIN_FREE_DISK_BYTES` | `1073741824` | Refuse uploads (507) below this much free space on `DATA_DIR` |
| `SESSION_COOKIE_NAME` | `sid` | Name of the httpOnly session cookie |
| `SESSION_MAX_AGE_HOURS` | `168` | How long a sign-in lasts, counted from when it happened and never extended by activity |
| `COOKIE_SECURE` | (empty = off) | Set to `1` only when serving over HTTPS; on plain HTTP a `Secure` cookie is dropped by the browser |
| `ADMIN_ID` | (empty) | Id of the first admin, created at startup if absent. Nothing is created when this is unset, and the log says so |
| `ADMIN_PASSWORD` | (empty) | **No default, ever.** Empty or shorter than 8 characters is refused at startup with an explicit log line |
| `ADMIN_NAME` / `ADMIN_EMAIL` | (empty) | Display name and email for that admin; both fall back to something derived from `ADMIN_ID` |
| `LOGIN_ATTEMPTS_PER_MINUTE` | `10` | Login attempts per minute **per id** (429) |
| `LOGIN_ATTEMPTS_PER_IP_PER_MINUTE` | `30` | Login attempts per minute **per address** (429) |
| `BACKEND_URL` | `http://localhost:8080` | Dev-only: where `vite.config.ts` proxies `/api` to |

## API

Full contract lives in the code (`server/routes/*.ts`, `server/types.ts`).
Summary:

**Hardening for a port reachable from outside.** Signing in mints a NEW session
id and discards the one the browser arrived with, so a planted cookie cannot be
upgraded into someone else's session. A sign-in expires `SESSION_MAX_AGE_HOURS`
(default 168) after it happened, enforced server-side rather than trusted to the
cookie. Every response carries a content policy plus `X-Frame-Options`,
`X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`. Signup and
password change are rate limited alongside login. The filesystem tools refuse
every dotfile, because `TOOL_FS_ROOT` defaults to the application directory and
`.env` lives there. Registering or removing a model endpoint is admin-only: it
makes the server fetch an address of the caller's choosing and then offers that
endpoint to everyone else.

What this does NOT fix: the deployment speaks plain HTTP, so credentials and the
session cookie cross the network in the clear and `Secure` cannot be set on the
cookie. Put it behind TLS (then set `COOKIE_SECURE=1`) or reach it over a VPN or
an SSH tunnel; nothing in the application can substitute for that.

**Public (reachable signed out):** `POST /api/auth/signup`, `POST /api/auth/login`,
`POST /api/auth/logout`, `GET /api/auth/me`, and `GET /api/health` as a liveness
ping only. **Everything else under `/api` answers
`401 {"code":"unauthorized"}`** until a signed-in account with status
`active` is behind the request. The SPA and static files are served to anyone —
the browser has to be able to load the app to show a login form.

`/api/health` is public because `./start_web.sh start` polls it for a 200 to
decide whether the server came up, and so does the container healthcheck;
gating it would make every deployment report a failed start for a server that is
running fine. Signed out it answers `{ backend: "ok", authenticated: false }` and
nothing more — the endpoint addresses, model names and vLLM reachability
breakdown are returned only to a signed-in account.

- `POST /api/auth/signup` `{ id, name, email, password }` — `201 { user, code: "pending_approval" }`; the account cannot sign in yet
- `POST /api/auth/login` `{ id, password }` — `200 { user }`, or `401 invalid_credentials` / `403 pending_approval` / `403 blocked` / `429 rate_limited`
- `POST /api/auth/logout` — `204`, always
- `GET /api/auth/me` — `200 { user }` or `401 unauthenticated`
- `POST /api/auth/password` `{ currentPassword, newPassword }` — `204`; changes the SIGNED-IN account's own password (the id comes from the session, never from the body). `403 invalid_credentials` when the current password is wrong, `400 weak_password` below the minimum length, `400 same_password` when the new one is already in use. Succeeding signs every **other** session of that account out and keeps the calling one
- `GET /api/admin/users` — every account with its status (admin only, else `403 not_admin`)
- `POST /api/admin/users/:id/approve` | `/block` | `/unblock` — `204` (admin only; blocking yourself is `400 cannot_block_self`)
- `DELETE /api/admin/users/:id` — `204`; removes the account, everything under `owners/{id}` (conversations and attachments) and every session naming it. Irreversible. Deleting yourself is `400 cannot_delete_self`, which is also what keeps at least one admin alive: only an admin reaches this route, so an admin being deleted always leaves the one doing it
- `GET/POST /api/admin/groups`, `PATCH/DELETE /api/admin/groups/:id` — admin-created groups. A group is a label an admin files accounts under and grants nothing; deleting one unfiles its members rather than deleting them. Duplicate names are `409 duplicate_group`
- `PUT /api/admin/users/:id/group` `{ groupId }` — file an account under a group; `null` takes it out of one
- `GET /api/session` — session id (httpOnly `sid` cookie, 30-day)
- `GET/POST /api/conversations`, `GET/PATCH/DELETE /api/conversations/:id` — CRUD, scoped to the caller's **account**; another account's conversation 404s (never 403 — existence isn't leaked). Every conversation carries `kind: "chat" | "embedding"` (never null; a record without one reads as `"chat"`)
- `POST /api/conversations/:id/messages` — send a message, streamed back as Server-Sent Events (`user_message`, `turn_started`, `reasoning`, `content`, `tool_call`, `tool_result`, `usage`, `done`, `error`, terminated by `data: [DONE]`). `turn_started { startedAt, answerNowAfterMs }` follows `user_message` immediately for a chat turn (not for embedding) — the server's own clock and `ANSWER_NOW_THRESHOLD_MS`, so the client's "지금 답변하기" button times off the server rather than its own `Date.now()`. An embedding turn uses the same stream and the same events — `user_message` then `done` — with the vector on `done.message.embedding`
- `DELETE /api/conversations/:id/stream` — abort the in-flight vLLM request for that conversation (Stop: tears the response down)
- `POST /api/conversations/:id/answer-now` — "지금 답변하기": stop the current model call and move the turn to a wrap-up answer built from what it already has, without aborting the response the way Stop does. `204` on success, `404` when there is no turn running (already finished, or never started) — harmless either way, and scoped to the caller's own conversation like every other route here
- `GET /api/tools` — registered tools (name, description, category, JSON Schema parameters)
- `POST /api/conversations/:id/attachments?name=<percent-encoded filename>` — raw file bytes as the body (the file's own Content-Type is a hint only; the magic bytes decide). `201 { id, kind, name, mime, bytes, width?, height?, estimatedTokens?, chars?, inlined?, createdAt }`
- `GET/DELETE /api/conversations/:id/attachments/:aid` — the bytes / `204`
- `GET /api/models` — `{ models, current, catalog[] }`, proxied from `GET /v1/models` (the real model id is always fetched here, never hardcoded). Each catalog entry: `{ id, endpoint, baseUrl, reachable, capability, maxModelLen, attachments: { maxMessageTokens, maxFileTokens, maxFileBytes, maxImageWidth, maxImageHeight } }` — the same limits the server enforces, so the UI can gate an upload before it is sent. `capability` is `"chat" | "embedding" | "rerank" | "unusable"`, measured rather than declared; `current` is always a chat model
- `GET /api/models/endpoints` — `{ unprotected, endpoints: [{ label, baseUrl, source: "file"|"env", reachable, models, maxModelLen, latencyMs }] }`
- `POST /api/models/endpoints` `{ label?, baseUrl, apiKey? }` — validate and register a serving endpoint; `DELETE` with `{ baseUrl }` removes one (`409` for an entry that came from `VLLM_ENDPOINTS`)
- `GET /api/health` — `{ backend, vllm, model?, latencyMs? }`

### Reasoning control

| `settings.reasoningLevel` | Sent to vLLM |
|---|---|
| `off` | `chat_template_kwargs.enable_thinking = false` (no `reasoning_effort`) |
| `low` / `medium` / `high` | `reasoning_effort` + `chat_template_kwargs.enable_thinking = true` + `thinking_token_budget` |

Streaming reasoning is read from `delta.reasoning`, falling back to
`delta.reasoning_content` for older vLLM builds.

### Tool-calling loop

When `enabledTools` is non-empty, `tools` + `tool_choice: "auto"` are sent to
vLLM. Streamed `delta.tool_calls` fragments are accumulated by `index`
(arguments are a string that grows across chunks) and `JSON.parse`d once the
turn ends; a parse failure produces a `tool_result` with `ok:false` instead
of crashing. The loop is **uncapped in rounds; the context budget ends it (see `TOOL_MAX_ROUNDS`, `CONTEXT_TOOL_STOP_RATIO`)** per message —
if the model still wants to call tools on the 5th round, the loop stops and
the persisted message carries an `error` explaining the cap (it does not
execute a 6th round). Usage is summed across every round-trip.

If the final content is empty/whitespace but reasoning isn't, reasoning is
promoted into `content` and `contentPromotedFromReasoning: true` is set —
insurance against [vLLM #40816](https://github.com/vllm-project/vllm); it
does not reproduce on the vLLM build this was verified against.

History replay to vLLM strips `reasoning` from prior turns (Qwen's template
discards previous-turn thinking) and reconstructs any prior tool-using turn
as `assistant(tool_calls) -> tool result(s) -> assistant(final content)`,
even though it's persisted as a single flattened message.

## Attachments

A message may carry up to 6 attachments (`attachmentIds` on
`POST /api/conversations/:id/messages`, whose `content` may then be empty).

**Images** (PNG, JPEG, GIF, WebP) become `image_url` content parts on the
**user** message — images first, then exactly one text part — encoded once per
turn in `buildHistoryMessages`. A system message never carries parts: the server
answers `400 System message cannot contain images`. Only `data:` URLs are used;
an `http://` URL would make the GPU host fetch it and `file://` is refused.

**Text** at or below `ATTACHMENT_INLINE_TEXT_BYTES` is inlined verbatim as a
labelled fenced block (`[첨부 파일: nginx.conf · 텍스트 · 4,812자]`, language from
the extension, fence widened if the file itself contains backticks). Above that
the prompt gets a stub — the attachment id and a ~400-character preview — and
the model reads the rest with the `read_attachment` tool, which is added to the
tools array **only** when the conversation actually holds such an attachment. It
takes an id, never a path, and resolves only within the current session and
conversation.

**Refusals** carry a machine-readable `code` beside the human `error`
(`too_large`, `unsupported_type`, `unsupported_document`, `undecodable_text`,
`too_many`, `quota`, `rate_limited`) so the UI can choose its own wording:

| Case | Status / code |
|---|---|
| PDF (`%PDF-`) or Office/ZIP (`PK\x03\x04`) | `415 unsupported_document` — dependency-free PDF text extraction was measured and returns 0 characters from real Korean PDFs, so the message asks for a screenshot instead |
| HEIC/HEIF/AVIF, SVG, BMP, TIFF | `415 unsupported_type` (HEIC and SVG are measured 400s from the model server itself) |
| Not valid UTF-8, or binary by `read_text_file`'s own heuristic | `400 undecodable_text` |
| Over the byte, pixel-edge or single-file token limit | `413 too_large` |
| Over a conversation/session quota, or under 1GB free on `DATA_DIR` | `413 quota` / `507` |
| More than `ATTACHMENT_MAX_PER_MESSAGE` in one message | `400 too_many` |
| More than `ATTACHMENT_UPLOADS_PER_MINUTE` from one session | `429 rate_limited` |

**Token budget.** An image costs `clamp(round(w*h/1000), 66, 16386)` prompt
tokens — measured, and the ceiling is the server's own rescaling, so no single
image can exceed ~6.3% of a 262k window. Inlined text is charged a pessimistic
`ceil(chars / 2)`. A message whose attachments together exceed
`floor(maxModelLen x ATTACHMENT_MESSAGE_TOKEN_RATIO)` is refused before the turn
starts, naming every file and its cost; a single file above half that budget is
refused at upload, where the user can still choose a smaller one.

**Context budget.** The ladder in `server/chat/contextBudget.ts` gained a rung
between "shrink tool results" and "drop oldest turns": evict old images, oldest
first, never on a protected message, leaving a Korean placeholder saying the
image was dropped and can be re-uploaded. The batch is planned from the recorded
per-image costs and re-measured **once** — `/tokenize` on a 16-image list
measured 1.2-7.7s against 0.15-0.86s for the same token count as text.
Compaction sends the placeholder to the summariser as well, while the rebuilt
context keeps the images verbatim.

## Accounts

Every `/api` route except `POST /api/auth/{signup,login,logout}` and
`GET /api/auth/me` requires a signed-in account whose status is `active`. Static
files and the SPA are served to anyone, so an unauthenticated browser can still
load the app and show a login screen.

**The flow.** A visitor registers with id, name, email and password; the account
is created `pending` and cannot sign in. An admin approves it (`active`), and
can `block` it later (and `unblock` it again).

```
signup ──► pending ──approve──► active ──block──► blocked
                                  ▲                 │
                                  └─────unblock─────┘
```

**Sessions.** Login does not mint a parallel token: the existing `sid` cookie
gains an owning user, and logout removes it. Authorisation re-reads the account
file on **every** request, so blocking a user stops their live session on its
very next request rather than at cookie expiry — measured in the verification
run below, where the same cookie goes from `200` to `403 blocked` with no
re-login in between.

**Passwords** are `node:crypto` scrypt with `N=32768, r=8, p=1`, a 32-byte
random per-user salt and a 64-byte key, compared with `timingSafeEqual`. That
costs 32 MiB of memory and ~70 ms per hash on this machine — unnoticeable on a
login, ruinous for a brute-force run — and `maxmem` has to be raised explicitly
because Node's default cap is exactly the 32 MiB scrypt needs. The stored string
is self-describing (`scrypt$N$r$p$salt$hash`) so the parameters can be raised
later without invalidating existing hashes. The password itself is never stored,
never logged and never returned by any endpoint.

**Error codes** ride on every refusal so the UI picks its own Korean wording:
`invalid_credentials`, `pending_approval`, `blocked`, `duplicate_id`,
`weak_password` (minimum 8 characters), `invalid_input`, `unauthorized` (401),
`not_admin`, `not_found`, `rate_limited`, `cannot_block_self`. Every refusal
also carries a ready-to-show Korean `error` sentence, so a client that does not
map a particular code still has something correct to display.

**A failed login never reveals whether an id exists.** A wrong password and an
unknown id return byte-identical responses, and the unknown id is verified
against a throwaway hash so the two also take the same amount of time.
`pending_approval` and `blocked` *are* distinguished: those are states the
person already knows they are in, and telling a waiting applicant "wrong
password" sends them off to reset a password that is perfectly correct.

**Login is rate-limited** in the same in-memory token-bucket shape the upload
route uses: 10 attempts/minute per id and 30/minute per address, refilled
continuously, `429 rate_limited` when spent. Two buckets because they stop two
different attacks — a password list against one account, and one host working
through many accounts — and the per-IP figure is the looser of the two because a
whole office can share one address.

**Bootstrapping the first admin.** Without an admin nobody can approve anything,
so `ADMIN_ID` + `ADMIN_PASSWORD` (+ `ADMIN_NAME`, `ADMIN_EMAIL`) create one at
startup if that id does not already exist. There is **no default password**:
empty or shorter than 8 characters is refused with an explicit log line, and
when no admin exists and `ADMIN_ID` is unset the startup log says so in as many
words. Changing `ADMIN_PASSWORD` afterwards does **not** reset an existing
admin's password — the log says that too, rather than pretending to.

```
[auth] created admin account "root" (root@example.com) from ADMIN_ID/ADMIN_PASSWORD — sign in and approve pending signups.
[auth] refusing to create admin "root": ADMIN_PASSWORD is only 5 characters, and at least 8 are required. No admin account was created.
[auth] no admin account exists and ADMIN_ID is not set. Nobody can approve signups. Set ADMIN_ID, ADMIN_PASSWORD, ADMIN_NAME and ADMIN_EMAIL and restart.
```

## Model capabilities

`/v1/models` lists what a server is configured for, not what works. Measured
2026-09-12 against the `WiseLLoA` gateway, three of its five models fail the
moment anyone picks them:

| model | probe result | published as |
|---|---|---|
| a chat model | chat 200 (emits `tool_calls`, accepts `image_url` parts) | `chat` |
| a thinking model | chat 200 — a **thinking** model: at `max_tokens:1` the whole budget goes to `reasoning` and `content` comes back empty | `chat` |
| a stale catalog entry | 400 `Invalid model name` on all three APIs | **excluded** |
| an embedding model | chat 400, `/v1/embeddings` 200 `dim=1024` | `embedding` |
| a reranker | chat 400, embeddings 400, `/v1/rerank` 200 | `rerank` |

So each newly seen model gets one tiny probe when the catalog is built — chat,
then embeddings, then rerank, stopping at the first success — and the verdict is
cached for the life of the process, so the 60-second catalog refresh never
repeats it. `MODEL_CAPABILITY_PROBE=0` skips the whole thing. Models that answer
nothing are dropped from `/api/models` with one line per exclusion naming the
model and quoting the server's own refusal.

**A 200 with a `choices` array is chat, whatever is inside it.** The
thinking model returns empty `content` for a one-token probe; judging capability
on the text would delete a perfectly good model from the picker. Likewise a
probe that gets no trustworthy answer at all — a transport failure, a 5xx, or a
401/403 that is really about the endpoint's key — is *undecided*, not a failure:
the model stays listed as `chat` and is probed again on the next refresh, because
hiding a working model when a GPU host is briefly busy is the worse outcome.

**This gateway serves no `/tokenize` either** (404, measured). Exact prompt
token counts are a vLLM extension, not part of the OpenAI API, so on such an
endpoint the context ladder works from the character estimate
(`server/vllm/client.ts`) and — with no window reported either — sends the
request unbudgeted, exactly as it already did for any model that reports no
window. The 404 is remembered per endpoint after the first turn, so it costs one
wasted round trip and one log line per process, not one per turn.

**This gateway reports no `max_model_len` for any model.** Everything derived
from the context window therefore has to have a real fallback: the attachment
budget falls back to `ATTACHMENT_DEFAULT_MESSAGE_TOKENS`, so `/api/models`
publishes `{ maxMessageTokens: 65536, maxFileTokens: 32768 }` for these models —
real numbers, never `null` and never `NaN`.

### Embedding conversations

When the selected model's measured capability is `embedding`, a turn embeds the
user's text instead of answering it. **None of the chat path runs**: no system
prompt, no tools, no tool loop, no `/tokenize`, no context budget, no compaction
— one string in, one vector out (asserted by call-counting in the verification
script). The result rides the existing SSE stream on the `done` event, because
an embedding is a single response and inventing a second transport for one event
would buy nothing.

The assistant message carries:

```json
"embedding": { "model": "your-embedding-model", "dimensions": 1024,
               "vector": [ ... ], "cosineToPrevious": 0.5170 }
```

`cosineToPrevious` is the cosine against the previous embedding in the same
conversation, and `null` — not omitted, not `0` — for the first one: "nothing to
compare with" and "orthogonal" are different facts. A vector is computed in order
to be compared, and 1024 numbers with no reference point are not a result anyone
can act on. Token usage is on the message's own `usage.promptTokens`, like every
other kind of turn.

> **Size.** A 1024-float vector is ~20KB of JSON, so a three-turn embedding
> conversation is a ~66KB file (measured). That is accepted deliberately: the
> vector *is* the answer here, and storing a truncated one would make the saved
> conversation useless for the comparison it exists for. Chat conversations are
> unaffected.

**A conversation keeps its kind.** `kind` is fixed by the first message and
never changes; sending with a model of the other capability is refused with
`409 capability_mismatch` and a Korean message telling the user to start a new
conversation. Mixing embedding and chat turns in one transcript makes it
unreadable and the sidebar icon meaningless. Attachments on an embedding turn
are refused with `embedding_no_attachments`.

**Rerankers are listed but not selectable.** A reranker needs a query *plus* a
document list, which no chat composer expresses, so it is published with
`capability: "rerank"` and refused at send time with `400 rerank_unsupported`
and a sentence saying why — rather than forwarding the gateway's raw
`litellm.BadRequestError`.

## Serving endpoints

Endpoints come from `VLLM_ENDPOINTS` **and** from an optional file, merged and
de-duplicated by `baseUrl` (the file wins on a label/key conflict, env order is
preserved so the default model does not move). Lookup order for the file:
`MODEL_ENDPOINTS_FILE`, then `./.model`, then `{DATA_DIR}/.model`.

```
# 한 줄에 하나. "라벨|주소|키?" 또는 주소만.
Local|http://localhost:8000/v1
http://10.0.0.11:8000/v1
```

Use `{DATA_DIR}/.model` in the container: only `data/` and `log/` are
bind-mounted, so a `.model` baked into the image cannot be edited without a
rebuild or a `docker cp`. The file's mtime is checked on every catalog refresh,
so a new line takes effect within the 60s cache instead of at the next restart,
and each endpoint is probed once at startup with a one-line-per-endpoint log. An
unreachable endpoint never blocks startup; its models stay listed with
`reachable: false` and are skipped when picking the default.

`POST /api/models/endpoints` validates before writing: `GET {baseUrl}/models`
with a **5 second** timeout, and the **shape** is the test — `object: "list"`
plus a non-empty `data[]` of objects with string ids. HTTP 200 is not enough:
this very app answers `GET /v1/models` with 200 and an HTML body (Express falls
through to `index.html`), and that is measured, not hypothetical. A pasted
`host:port` is normalised to `http://host:port/v1`. An API key is stored and
sent but **cannot be validated** — the same request with a deliberately wrong
bearer token also returns 200, because these servers do not require auth.

> **Security.** This endpoint makes the server fetch an address of the caller's
> choosing. Every `/api` route now requires a signed-in, approved account, so
> "any visitor" is no longer the exposure; without `MODEL_ADMIN_TOKEN` it is
> every approved **user** who can probe hosts and ports from inside your network,
> or register an endpoint that quietly receives other people's conversations.
> Set it unless you trust every account. Mutations are
> logged with the client IP either way, and `GET /api/models/endpoints` reports
> `unprotected: true` so the UI can say so. There is deliberately no
> private-range block: serving endpoints are often on the same private network
> as this app, so such a rule would block exactly the machines this exists for.

## Storage

```
data/auth/users/<userId>.json                                           one account per file
data/sessions/<sessionId>/session.json                                  written at login, not before
data/owners/<userId>/conversations/<conversationId>.json
data/owners/<userId>/attachments/<conversationId>/<attachmentId>.bin    raw bytes
data/owners/<userId>/attachments/<conversationId>/<attachmentId>.json   metadata sidecar
data/.model                                                             optional endpoints file
```

Conversations are keyed by the **owner** (the account id), not by the browser
session that created them. Session-keyed storage would show an empty app to
someone who signs in from a second browser, because that browser has its own
`sid`.

> **The 21 pre-accounts session directories are still on disk and are now
> unreachable.** `data/sessions/<uuid>/conversations/` was the old location, and
> those conversations belong to anonymous browser sessions that cannot be
> attributed to any account. Nothing reads that path any more — not the app, not
> the attachment sweep — and nothing deletes or rewrites it either. Losing
> someone's history to a migration onto a guessed owner would be worse than an
> orphaned directory. If a user turns out to need one of them, an operator can
> copy the JSON file into `data/owners/<userId>/conversations/` by hand.

- Writes are atomic: `<file>.<pid>.<random>.tmp` then `fs.rename`, so a crash
  never leaves a truncated JSON file.
- Accounts are one file per user with no index. An index would be a second copy
  of the same truth, rewritten under a lock spanning every user on each signup
  and status change, and silently wrong after a crash between the two writes.
- User ids are lowercased `^[a-z0-9_-]{3,32}$`. Lowercase is load-bearing, not
  cosmetic: the id is a path segment and macOS/Windows filesystems are
  case-insensitive, so `Alice` and `alice` would be two accounts sharing one
  conversation directory.
- Session/conversation ids are validated against `^[A-Za-z0-9_-]{1,64}$`
  before touching the filesystem — anything else is rejected (no path
  traversal).
- A session record is written **at login**, not on first contact. Since every
  anonymous `/api` request is refused anyway, persisting one per request would
  let anyone with curl fill `DATA_DIR` with empty `session.json` files. The
  cookie is still issued on first contact, so the id is stable either way.
- Writes to the same conversation are serialised through an in-process
  mutex (`server/storage/mutex.ts`) so concurrent requests can't interleave.
- A corrupt/unreadable conversation file is skipped (with a logged warning)
  in listings rather than crashing the server.
- Attachment paths contain only server-generated UUIDs. The uploaded filename
  travels in the query string (headers are latin-1, so a Korean name would
  arrive as mojibake) and is stored as display metadata only — never as a path
  component.
- Deleting a conversation deletes its attachment directory inside the same lock.
  Attachments that no message references are swept 30 minutes after upload, on
  send and at startup — an upload the user never sent would otherwise live
  forever.
- `server/tools/fsRoot.ts` refuses any path inside `DATA_DIR`, so the filesystem
  tools cannot read attachments, anyone's conversations, or the password hashes
  under `data/auth/`; `read_attachment` reads the bytes directly instead of
  going through that resolver.

## Tools

Shipped tools (10s timeout, 100KB result truncation, every execution logged
with name/args-summary/duration/ok-or-fail):

| Tool | What it does |
|---|---|
| `calculator` | Evaluates an arithmetic expression via a hand-written recursive-descent parser (`server/tools/safeMath.ts`) — **no `eval`/`Function`**. Supports `+ - * / % ^`, parentheses, common `Math` functions, and `pi`/`e`. |
| `get_current_time` | Current time, optionally converted to an IANA timezone; returns ISO 8601 UTC + a human-readable string. |
| `http_fetch` | GETs a URL, returns status + text (HTML stripped to readable text, capped download size). SSRF guards: http/https only; hostname is resolved and rejected if it lands on loopback, link-local (`169.254/16`), or RFC1918 private ranges; each redirect hop is re-validated the same way; `TOOL_FETCH_ALLOWLIST` (if set) restricts to those exact hostnames. |
| `read_text_file` | Reads a UTF-8 text file under `TOOL_FS_ROOT`. The path is resolved (`fs.realpath`, following symlinks) and checked to still be inside the root **after** resolution, so `..` and symlinks can't escape it. Binary files are rejected. |
| `list_directory` | Lists entries under `TOOL_FS_ROOT` with the same containment check as `read_text_file`. |
| `read_attachment` | Reads a text attachment of the **current** conversation by its `attachment_id` (never a path), 40,000 characters per call with `offset`/`length` paging. Offered only when the conversation holds a text attachment whose body was too large to inline; not listed in `GET /api/tools` and not user-toggleable. |
| `weather_lookup` | Current weather (temperature, feels-like, humidity, wind, conditions) for a place name, via Open-Meteo geocoding + forecast. Keyless. |
| `wikipedia_lookup` | Short encyclopedic summary + canonical URL for a topic, via English Wikipedia's search + REST summary APIs. Keyless. |
| `currency_convert` | Converts an amount between ISO 4217 currency codes using the latest daily ECB reference rates (frankfurter.dev). Keyless. |
| `unit_convert` | Converts a value between units of length, mass, volume, speed, area, digital storage, or temperature. Category is auto-detected; local computation, no network. |
| `datetime_calc` | Converts a date/time to a different IANA timezone and/or shifts it by an amount of time (add/subtract days/hours/minutes/seconds). Local computation. |
| `article_extract` | Fetches a page and extracts just its readable article text and title (nav/ads/boilerplate filtered out) — a cleaner alternative to `http_fetch` for "read this link" requests. Same SSRF guard as `http_fetch`. |
| `text_stats` | Character/word/sentence/paragraph counts, estimated reading time, and top words for a block of text. Local computation. |
| `data_convert` | Converts between JSON and CSV, or pretty-prints/minifies JSON. Hand-written CSV parser/serializer (RFC 4180-ish quoting). Local computation. |
| `encode_decode` | Base64, base64url, hex, and URL-component encode/decode, plus JWT decode (header/payload only, signature **not** verified). Every decode path rejects malformed input explicitly (Node's `Buffer` base64 decoding is otherwise lenient). Local computation. |
| `hash_text` | md5/sha1/sha256/sha512 hex digest of a text string, via `node:crypto`. Local computation. |
| `generate_random` | Cryptographically random v4 UUIDs or hex/base64 tokens, via `node:crypto`. Local computation. |
| `color_convert` | Converts a color between hex, `rgb()`, and `hsl()` notation, accepting any one of the three as input. Local computation. |
| `diff_text` | Line-based diff of two texts (LCS algorithm) with long unchanged runs collapsed to a context-window summary. Local computation, capped at 2,000 lines/side. |
| `regex_test` | Applies a regular expression to text and reports matches with their index, numbered groups and named groups. A user-supplied pattern runs in the server process, so patterns that can backtrack catastrophically are **rejected before they run**: a hand-written parser refuses a group repeated more than once that contains another unbounded repetition (`(a+)+`, `(.*a){25}`) or whose alternatives can match the same text (`(a\|ab)+`), and input is capped at 20,000 characters. The comment in the file is explicit about what this does not catch (backreference-driven blowup, constructs the parser cannot model). Local computation. |
| `json_query` | Extracts values from a JSON document by a small path language: dotted keys, array indexes, `items[*].name`, `*.id`. Returns each value with the concrete path it came from, and names the failing segment when nothing matches. Local computation. |
| `sort_unique` | Sorts, deduplicates, or counts occurrences of lines, with numeric/case-insensitive/trim options. `sort -u` semantics, output capped at 1,000 lines. Local computation. |
| `unicode_inspect` | Per-code-point breakdown (character, `U+XXXX`, UTF-8 byte length, control/zero-width flags) plus all four normalization forms and which differ. Detects precomposed Hangul versus decomposed jamo and flags invisible characters — the usual reason two "identical" strings do not match. Local computation. |
| `cidr_calc` | IPv4 subnet arithmetic: network, broadcast, netmask, wildcard, first/last usable host, address and host counts, private/loopback/link-local classification, and an optional membership test. `/31` and `/32` are special-cased rather than reported as a nonsense range. Local computation. |
| `cron_describe` | Explains a 5-field cron expression in plain language and lists the next runs in a given timezone. Supports lists, ranges, steps and three-letter names, with Vixie day-of-month/day-of-week OR semantics. The search for next runs is hard-bounded, so an expression that never fires reports that instead of looping. Local computation. |
| `url_parse` | Splits a URL into scheme, host (IP literal vs domain, with IDN/punycode shown in Unicode), port including the scheme default, path segments, percent-decoded query parameters preserving repeats, and fragment. A password in the URL is reported as present and never echoed. Local computation. |

No shell execution, file writes, or anything destructive is implemented.

A conversation stores the tool list it was created with, so conversations that
predate a newly added tool do not get it until it is switched on for them in
도구 설정. New conversations get everything.

### Adding a tool

Drop one file into `server/tools/` exporting a `ToolDefinition`:

```ts
// server/tools/myTool.ts
import type { ToolDefinition } from "./types.js";

export const myTool: ToolDefinition = {
  name: "my_tool",
  description: "What it does, written for the model.",
  category: "utility",
  parameters: {
    type: "object",
    properties: { foo: { type: "string" } },
    required: ["foo"],
    additionalProperties: false,
  },
  async execute(args: { foo: string }) {
    return { result: args.foo };
  },
};
```

Then register it in `server/tools/index.ts` (add to the `ALL_TOOLS` array).
The runner (`server/tools/runner.ts`) applies the 10s timeout, 100KB
truncation, and logging automatically — tools don't need to implement any of
that themselves.

## Project structure

```
server/
  index.ts, app.ts, config.ts, types.ts   Express bootstrap, env config, shared contract types
  middleware/session.ts                    httpOnly `sid` cookie issuance/lookup
  middleware/auth.ts                       resolve the session's account; refuse every non-public /api route
  auth/password.ts                         scrypt hashing + constant-time verification
  auth/bootstrap.ts                        the first admin, from ADMIN_ID/ADMIN_PASSWORD
  routes/                                  auth, admin, session, conversations (+ SSE messages endpoint), tools, models, health
  storage/                                 atomic JSON read/write, per-key mutex, user/session/conversation stores
  vllm/client.ts                           fetch models, health check, streaming chat completions, embeddings
  vllm/capability.ts                       measure what each model can do (chat / embedding / rerank / unusable)
  vllm/endpoints.ts                        the .model endpoints file: lookup, merge with env, hot reload, probe
  attachments/                             magic-byte sniffing + dimensions (sniff.ts), token cost model (budget.ts)
  chat/                                    history-to-vLLM-messages builder, the tool-calling loop, the embedding turn
  tools/                                   tool registry + the shipped tools
src/                                       frontend (owned by a different workstream — not touched here)
dist/                                      built SPA (served statically by the backend)
dist-server/                               compiled server (from `npm run build:server`)
data/                                      accounts + per-account conversation JSON files (gitignored)
run/, log/                                 start_web.sh pid file / daily logs (gitignored)
```

## Deployment (container)

The app runs as the `qwen-web` container, port 9000, from `qwen-web:1.x`. Only
two paths are bind-mounted:

```
<host-dir>/data -> /app/data   (accounts, conversations, attachments)
<host-dir>/log  -> /app/log    (daily logs; stdout lands here, NOT in `docker logs`)
```

Everything else — including the code — lives in the container's own writable
layer. A deploy is `docker cp` of a freshly built `dist/` + `dist-server/`
followed by restarting the node process inside the container, so **the running
code is `/app/dist-server` inside the container, not the `dist-server` sitting
in the host directory of the same name.** That host copy is whatever was last
extracted there and drifts stale; grepping it to find out what is deployed will
mislead you. Read the running file instead:

```
docker exec qwen-web grep -c somethingYouJustAdded /app/dist-server/routes/conversations.js
```

The consequence to remember: `docker restart` keeps the deployed code (the
writable layer survives), but `docker rm` followed by `docker run` silently
reverts the container to whatever the image was baked with. So after a run of
deploys, re-bake the image from the same source that is running:

```
docker build -t qwen-web:1.1 .       # in a scratch copy of the source, not the live directory
docker run --rm qwen-web:1.1 stat -c %s /app/dist-server/routes/conversations.js
```

and check that size against the running file before trusting the tag. Older
tags are kept rather than overwritten (`1.0`, `backup-YYYYMMDD`) so there is
always something to fall back to. The restart policy is `no` and `.env` (mode
600, holding `TAVILY_API_KEY`) lives in the host directory, outside both the
image and the mounts — a rebuild never carries it, which is the point.

## Troubleshooting

**`./start_web.sh status` shows `vllm: unreachable`.** The backend checks
reachability by calling `GET {VLLM_BASE_URL}/models` — confirm the pod/host
in `VLLM_BASE_URL` is up and that port is reachable from this machine.

**A reply looks empty even though the model clearly generated something.**
See "If the final content is empty/whitespace..." above — the backend
promotes reasoning into content and marks `contentPromotedFromReasoning`
rather than showing a blank message.

**A tool call never finishes / times out.** Every tool has a hard 10s
timeout (`server/tools/runner.ts`); a timeout is reported as a normal
`tool_result` with `ok:false`, not a crash.
