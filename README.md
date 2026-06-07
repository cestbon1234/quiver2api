# Quiver2API

Local account-pool proxy for QuiverAI.

## What Was Reversed

The current Quiver web app is a Nuxt SPA. Its public frontend bundle shows these active endpoints:

- `POST /api/auth/magic` sends an email code.
- `POST /api/auth/magic/verify` verifies the six-digit code and sets `nuxt-session`.
- `GET /api/_auth/session` returns the current session.
- `GET /api/billing/balance` returns credit balance as `data.credits`.
- `GET /api/billing/subscription` returns subscription data.
- `GET /api/billing/transactions` returns credit usage records.
- `GET /api/chat/access` reports whether the current account can use Agent/Chat.
- `GET/POST/PATCH/DELETE /api/chats` manages chat summaries.
- `POST /api/chat` sends the actual AI generation/chat request as an SSE stream.

This project uses the normal authenticated cookie flow. It does not bypass captcha, rate limits, or Quiver access controls.

The official QuiverAI API is separate from the web app cookie flow. It uses
`https://api.quiver.ai/v1` plus a Bearer API key created in
`https://app.quiver.ai/settings/api-keys`.

## Start

```bash
npm install
npm start
```

Create a private env file before starting:

```powershell
Copy-Item .env.example .env
```

Or on macOS/Linux:

```bash
cp .env.example .env
```

Default URL:

```text
http://localhost:3000
```

## Configuration

Runtime configuration is loaded from `.env` automatically. Keep `.env` private;
commit `.env.example` only.

Supported environment variables:

| Variable | Purpose |
| --- | --- |
| `PORT` | Local server port. Defaults to `3000`. |
| `QUIVER2API_KEY` | Optional local API key required by `/v1` endpoints. |
| `LOCAL_API_KEY` | Backward-compatible alias for `QUIVER2API_KEY`. |
| `QUIVER2API_DB` | SQLite database path for accounts, sessions, and saved config. Defaults to `accounts.db`. |
| `ACCOUNTS_DB_PATH` | Backward-compatible alias for `QUIVER2API_DB`. |
| `QUIVERAI_API_KEY` | Optional official QuiverAI API key for `/api/official/*`. |
| `YYDS_API_KEY` | Optional YYDS Mail API key for automatic registration. |
| `QUIVER_PROXY` | Optional HTTP/HTTPS proxy URL for Quiver and mailbox API requests. |
| `QUIVER2API_ENV_FILE` | Optional path to a non-default env file. Defaults to `.env`. |

Secrets and runtime files are ignored by git, including `.env`, `accounts.db`,
logs, and temporary web-scan output.

## Accounts

Add an account with a Quiver cookie:

```bash
curl -X POST http://localhost:3000/api/accounts/import-web \
  -H "Content-Type: application/json" \
  -d "{\"cookies\":\"nuxt-session=...\"}"
```

This validates the web session, reads the account email from Quiver, refreshes
balance and Chat/Agent access, then saves the account as `active` or `no_access`.
You can still use `/api/accounts` if you only want to store a cookie without
checking it.

List accounts:

```bash
curl http://localhost:3000/api/accounts
```

Import a normal Quiver web account with email code:

```bash
curl -X POST http://localhost:3000/api/auth/magic \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"user@example.com\",\"intent\":\"signin\"}"
```

After receiving the six-digit code:

```bash
curl -X POST http://localhost:3000/api/auth/magic/verify \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"user@example.com\",\"code\":\"123456\"}"
```

If the response status is `active`, that web account is ready for `/v1` calls.
If it is `no_access`, the session was imported but Quiver has not enabled
Chat/Agent on that account, so it can show balance but cannot generate.

## Balance

Use automatic account rotation:

```bash
curl http://localhost:3000/api/balance
```

Use a specific account:

```bash
curl "http://localhost:3000/api/balance?email=user@example.com"
```

Check all active accounts:

```bash
curl http://localhost:3000/api/balance/all
```

## Web-Credit API

The `/v1` endpoints are meant for external tools. They use imported
`https://app.quiver.ai` web sessions and consume the web account's Quiver
credits. They do not require a QuiverAI official API key.

Optional local API key:

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"local_api_key\",\"value\":\"YOUR_LOCAL_KEY\"}"
```

When `local_api_key` is set, call `/v1` with:

```text
Authorization: Bearer YOUR_LOCAL_KEY
```

List web-backed models:

```bash
curl http://localhost:3000/v1/models
```

Check whether the local API can generate right now:

```bash
curl http://localhost:3000/v1/status
```

Force a web-session access refresh before reporting status:

```bash
curl "http://localhost:3000/v1/status?refresh=true"
```

Read cached web-account credits:

```bash
curl http://localhost:3000/v1/balance
```

Refresh credits from Quiver before returning them:

```bash
curl "http://localhost:3000/v1/balance?refresh=true"
```

Generate SVG through the web account pool:

```bash
curl -X POST http://localhost:3000/v1/svgs/generations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"prompt\":\"A clean SVG logo for a calendar app\",\"n\":1}"
```

Generate SVG with a reference image:

```bash
curl -X POST http://localhost:3000/v1/svgs/generations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"prompt\":\"Turn the reference into a clean flat SVG logo\",\"references\":[{\"base64\":\"BASE64_IMAGE_DATA\",\"filename\":\"reference.png\",\"mime_type\":\"image/png\"}]}"
```

Reference inputs can be a Quiver upload ID, an HTTP image URL, a data URL, or
base64 image data:

```json
{
  "references": [
    { "uploadId": "existing-quiver-upload-id" },
    { "url": "https://example.com/reference.png" },
    { "base64": "BASE64_IMAGE_DATA", "filename": "reference.png", "mime_type": "image/png" }
  ]
}
```

Vectorize an existing image into SVG with Quiver web's image-to-SVG mode:

```bash
curl -X POST http://localhost:3000/v1/svgs/vectorizations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"image\":{\"base64\":\"BASE64_IMAGE_DATA\",\"filename\":\"source.png\",\"mime_type\":\"image/png\"}}"
```

You can also vectorize a previously uploaded Quiver image directly:

```bash
curl -X POST http://localhost:3000/v1/svgs/vectorizations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"image\":{\"uploadId\":\"existing-quiver-upload-id\"}}"
```

Use a specific imported account:

```bash
curl -X POST http://localhost:3000/v1/svgs/generations \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"user@example.com\",\"model\":\"arrow-1.1\",\"prompt\":\"A simple rocket icon\"}"
```

OpenAI image-generation compatible clients can call the same web account pool:

```bash
curl -X POST http://localhost:3000/v1/images/generations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"prompt\":\"A simple rocket icon\",\"response_format\":\"b64_json\"}"
```

OpenAI-style chat clients can also call:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"messages\":[{\"role\":\"user\",\"content\":\"A simple rocket icon as SVG\"}]}"
```

`/v1/svgs/generations` and `/v1/svgs/vectorizations` return `data[].svg` when
Quiver exposes the creation SVG inside the request window. Text/reference
generation waits up to 90 seconds by default; vectorization waits up to 180
seconds because Quiver's image-to-SVG mode is often slower. You can override this
with:

```bash
curl -X POST http://localhost:3000/v1/svgs/generations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"prompt\":\"A simple rocket icon\",\"wait_ms\":30000,\"poll_interval_ms\":2000}"
```

Set `"wait": false` if you only want the immediate SSE result. When Quiver still
has pending work, the response includes `status`, `task_ids`, `creation_ids`, and
per-output `status`/`error` fields. Refresh an existing result without submitting
a new Quiver generation:

```bash
curl -X POST http://localhost:3000/v1/svgs/results \
  -H "Content-Type: application/json" \
  -d "{\"object\":\"svg.vectorization\",\"email\":\"user@example.com\",\"task_ids\":[\"TASK_ID\"],\"creation_ids\":[\"CREATION_ID\"],\"wait_ms\":30000}"
```

Generation automatically re-checks imported web sessions when no `active` account
is available. If Quiver later enables Chat/Agent access on an imported account,
the API can recover it without manually editing the database.

## Chat / Generation

Check whether an account can use Quiver Agent/Chat:

```bash
curl "http://localhost:3000/api/access?email=user@example.com"
```

If Quiver returns `chat.enabled=false`, the local account status is set to `no_access`.
Those accounts can still have a valid session and readable balance, but they cannot be used
for `/api/chat` generation until Quiver enables Agent/Chat access for that account.

Run a full account diagnosis:

```bash
curl "http://localhost:3000/api/accounts/user%40example.com/diagnose"
```

The diagnosis checks the saved web session, detected email, balance endpoint,
Chat/Agent access, and Explore access separately. It updates the cached account
status by default; add `?update=false` if you only want to inspect.

You can also diagnose a pasted cookie without saving it:

```bash
curl -X POST http://localhost:3000/api/accounts/diagnose-web \
  -H "Content-Type: application/json" \
  -d "{\"cookies\":\"nuxt-session=...\"}"
```

Create a Quiver chat and send a prompt:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"prompt\":\"A clean SVG logo for a calendar app\",\"model\":\"arrow-1.1\",\"selectedGenerationCount\":1}"
```

Supported model values discovered from the frontend include:

- `arrow-1.1`
- `arrow-1.1-max`
- `arrow-1`

The response includes the raw SSE stream plus parsed text, task IDs, and creation IDs when present.

## Official API

Set a QuiverAI API key in the web UI or via config:

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"quiver_api_key\",\"value\":\"YOUR_QUIVERAI_API_KEY\"}"
```

List official models:

```bash
curl http://localhost:3000/api/official/models
```

Generate SVGs through the official API:

```bash
curl -X POST http://localhost:3000/api/official/generate \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"prompt\":\"A clean SVG logo\",\"n\":1,\"stream\":false}"
```

The public OpenAPI spec currently exposes models, text-to-SVG, and image-to-SVG
vectorization. It does not expose a balance endpoint; app-side balance still uses
`/api/billing/balance` with a web session cookie.

## Registration

Automatic registration uses the normal Quiver email-code flow plus YYDS mailbox polling.
After registration the service checks `/api/chat/access`; accounts without Agent/Chat
access are not usable for `/v1` generation. Auto-registration now treats Chat/Agent
access as required for generated temporary mailboxes, so a no-access signup is
removed from the account pool by default and reported as a failed usable registration.
Pass `{"keepNoAccess":true}` only if you intentionally want to keep those sessions
for diagnostics.

Current Quiver web behavior may accept a temporary-mail signup as a valid login
session while still returning `credits=0`, `/api/chat/access -> {"enabled":false}`,
and `/api/explore/access -> {"enabled":false}`. Local code cannot create Quiver-side
credits or permissions; import a real web account that can generate in
`https://app.quiver.ai` to make `/v1/status` become `ready:true`.

Set the YYDS key in the web UI or via environment variable:

```bash
set YYDS_API_KEY=AC-your-key
```

Optional HTTP/HTTPS proxy for Quiver and mailbox API requests:

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"proxy_url\",\"value\":\"http://127.0.0.1:7890\"}"
```

Start one registration:

```bash
curl -X POST http://localhost:3000/api/register
```

Start a small batch:

```bash
curl -X POST http://localhost:3000/api/register/batch \
  -H "Content-Type: application/json" \
  -d "{\"count\":3,\"delay\":8000}"
```

Batch registration is capped at 5 accounts per request.

## Tampermonkey Import

Install the helper userscript from the running local service:

```text
http://localhost:3000/quiver2api-export.user.js
```

After installing it in Tampermonkey, sign in or register normally on
`https://app.quiver.ai`. The floating Quiver2API panel can check the current
web account's Chat/Agent access and import the session into the local account
pool. The script only sends data to the configured local service URL
(`http://localhost:3000` by default).

If the browser blocks access to the HttpOnly `nuxt-session` cookie and
Tampermonkey's `GM_cookie` API is unavailable, the script can still check web
access but cannot import a reusable server-side cookie.
