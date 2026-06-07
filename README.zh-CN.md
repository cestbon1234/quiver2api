# Quiver2API

[English](README.md)

Quiver2API 是一个本地运行的 Quiver 网页账号池代理。它可以把已经登录并导入的 `https://app.quiver.ai` 网页账号额度包装成类似 OpenAI 的本地 API，用来生成 SVG、根据参考图生成 SVG，以及把图片矢量化成 SVG。

项目使用正常的 Quiver 网页登录 Cookie 流程，不绕过验证码、速率限制、权限或额度控制。调用生成接口会消耗被导入网页账号里的 Quiver Create 额度。

## 功能

- 本地前端访客页：文本生成 SVG、参考图生成 SVG、图片转 SVG。
- 后台管理页：导入账号、查看余额、刷新状态、配置 key。
- OpenAI 风格 `/v1` API：方便接入外部工具。
- 支持账号池轮换：自动选择可用的 Quiver 网页账号。
- 支持 pending 结果刷新：Quiver 生成较慢时，可以用旧任务 ID 补取 SVG，不会重复生成。
- 支持官方 QuiverAI API：可选，不影响网页额度模式。
- 支持 Tampermonkey 辅助导入网页会话。

## 快速开始

安装依赖：

```bash
npm install
```

复制环境变量模板。

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

macOS/Linux：

```bash
cp .env.example .env
```

启动服务：

```bash
npm start
```

默认访问地址：

```text
http://localhost:3000
```

后台管理页：

```text
http://localhost:3000/admin
```

Windows 上也可以用后台启动脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-detached.ps1 -Restart
```

## 环境变量

运行时会自动读取 `.env`。请只提交 `.env.example`，不要提交真实 `.env`。

| 变量 | 说明 |
| --- | --- |
| `PORT` | 本地服务端口，默认 `3000`。 |
| `QUIVER2API_KEY` | 可选，本地 `/v1` 接口鉴权 key。设置后需要传 `Authorization: Bearer <key>`。 |
| `LOCAL_API_KEY` | `QUIVER2API_KEY` 的兼容别名。 |
| `QUIVER2API_DB` | SQLite 数据库路径，保存账号、session、配置。默认 `accounts.db`。 |
| `ACCOUNTS_DB_PATH` | `QUIVER2API_DB` 的兼容别名。 |
| `QUIVERAI_API_KEY` | 可选，官方 QuiverAI API key，用于 `/api/official/*`。 |
| `YYDS_API_KEY` | 可选，YYDS 邮箱 API key，用于自动注册。 |
| `QUIVER_PROXY` | 可选，访问 Quiver 和邮箱 API 的 HTTP/HTTPS 代理。 |
| `QUIVER2API_ENV_FILE` | 可选，自定义 env 文件路径，默认 `.env`。 |

`.gitignore` 已经忽略 `.env`、`accounts.db`、日志、临时扫描目录和 `node_modules`。`accounts.db` 里会保存账号和 Cookie/session，请不要上传。

## 导入 Quiver 网页账号

最推荐的方式是在后台管理页导入，也可以直接调用接口。

导入已有 Quiver Cookie：

```bash
curl -X POST http://localhost:3000/api/accounts/import-web \
  -H "Content-Type: application/json" \
  -d "{\"cookies\":\"nuxt-session=...\"}"
```

服务会校验网页 session，读取账号邮箱，刷新余额和 Chat/Agent 权限，然后保存为：

- `active`：可以用于 `/v1` 生成。
- `no_access`：session 有效，但当前账号没有 Quiver 生成权限。

查看账号：

```bash
curl http://localhost:3000/api/accounts
```

使用邮箱验证码登录并导入：

```bash
curl -X POST http://localhost:3000/api/auth/magic \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"user@example.com\",\"intent\":\"signin\"}"
```

收到六位验证码后：

```bash
curl -X POST http://localhost:3000/api/auth/magic/verify \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"user@example.com\",\"code\":\"123456\"}"
```

## 余额和状态

查看本地缓存状态：

```bash
curl http://localhost:3000/v1/status
```

强制刷新 Quiver 网页账号状态：

```bash
curl "http://localhost:3000/v1/status?refresh=true"
```

查看网页账号余额：

```bash
curl http://localhost:3000/v1/balance
```

刷新后再返回余额：

```bash
curl "http://localhost:3000/v1/balance?refresh=true"
```

## 本地 API Key

如果你想保护本地 `/v1` 接口，可以配置 `QUIVER2API_KEY`，也可以通过后台配置：

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"local_api_key\",\"value\":\"YOUR_LOCAL_KEY\"}"
```

设置后调用 `/v1` 时需要带：

```text
Authorization: Bearer YOUR_LOCAL_KEY
```

## 网页额度 API

这些接口使用导入的 Quiver 网页账号，消耗网页账号的 Quiver 额度，不需要官方 QuiverAI API key。

列出模型：

```bash
curl http://localhost:3000/v1/models
```

文本生成 SVG：

```bash
curl -X POST http://localhost:3000/v1/svgs/generations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"prompt\":\"A clean SVG logo for a calendar app\",\"n\":1}"
```

根据参考图生成 SVG：

```bash
curl -X POST http://localhost:3000/v1/svgs/generations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"prompt\":\"Turn the reference into a clean flat SVG logo\",\"references\":[{\"base64\":\"BASE64_IMAGE_DATA\",\"filename\":\"reference.png\",\"mime_type\":\"image/png\"}]}"
```

参考图支持这些形式：

```json
{
  "references": [
    { "uploadId": "existing-quiver-upload-id" },
    { "url": "https://example.com/reference.png" },
    { "base64": "BASE64_IMAGE_DATA", "filename": "reference.png", "mime_type": "image/png" }
  ]
}
```

图片转 SVG，也就是 Quiver 网页端 Vectorize 模式：

```bash
curl -X POST http://localhost:3000/v1/svgs/vectorizations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"image\":{\"base64\":\"BASE64_IMAGE_DATA\",\"filename\":\"source.png\",\"mime_type\":\"image/png\"}}"
```

也可以直接使用已上传到 Quiver 的图片：

```bash
curl -X POST http://localhost:3000/v1/svgs/vectorizations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"image\":{\"uploadId\":\"existing-quiver-upload-id\"}}"
```

指定某个导入账号：

```bash
curl -X POST http://localhost:3000/v1/svgs/generations \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"user@example.com\",\"model\":\"arrow-1.1\",\"prompt\":\"A simple rocket icon\"}"
```

OpenAI 图片生成兼容接口：

```bash
curl -X POST http://localhost:3000/v1/images/generations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"prompt\":\"A simple rocket icon\",\"response_format\":\"b64_json\"}"
```

OpenAI Chat Completions 兼容接口：

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"messages\":[{\"role\":\"user\",\"content\":\"A simple rocket icon as SVG\"}]}"
```

## 等待和刷新结果

`/v1/svgs/generations` 和 `/v1/svgs/vectorizations` 会在 Quiver 暴露 SVG 后返回 `data[].svg`。

默认等待时间：

- 文本/参考图生成：最多 90 秒。
- 图片转 SVG：最多 180 秒，因为 Vectorize 通常更慢。

可以手动覆盖：

```bash
curl -X POST http://localhost:3000/v1/svgs/generations \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"prompt\":\"A simple rocket icon\",\"wait_ms\":30000,\"poll_interval_ms\":2000}"
```

如果只想拿即时结果，可以传 `"wait": false`。当 Quiver 还在生成时，响应里会包含 `status`、`task_ids`、`creation_ids` 和每个输出的状态。

刷新旧结果，不会重新提交生成任务：

```bash
curl -X POST http://localhost:3000/v1/svgs/results \
  -H "Content-Type: application/json" \
  -d "{\"object\":\"svg.vectorization\",\"email\":\"user@example.com\",\"task_ids\":[\"TASK_ID\"],\"creation_ids\":[\"CREATION_ID\"],\"wait_ms\":30000}"
```

## 账号诊断

检查某个账号是否能用 Quiver Agent/Chat：

```bash
curl "http://localhost:3000/api/access?email=user@example.com"
```

完整诊断：

```bash
curl "http://localhost:3000/api/accounts/user%40example.com/diagnose"
```

只诊断 Cookie，不保存：

```bash
curl -X POST http://localhost:3000/api/accounts/diagnose-web \
  -H "Content-Type: application/json" \
  -d "{\"cookies\":\"nuxt-session=...\"}"
```

## 官方 QuiverAI API

官方 QuiverAI API 和网页 Cookie 流程是两套系统。官方 API 使用 `https://api.quiver.ai/v1` 和 Bearer API key。

配置官方 API key：

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"quiver_api_key\",\"value\":\"YOUR_QUIVERAI_API_KEY\"}"
```

列出官方模型：

```bash
curl http://localhost:3000/api/official/models
```

官方 API 生成：

```bash
curl -X POST http://localhost:3000/api/official/generate \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"arrow-1.1\",\"prompt\":\"A clean SVG logo\",\"n\":1,\"stream\":false}"
```

## 自动注册

自动注册使用 Quiver 正常邮箱验证码流程和 YYDS 邮箱轮询。注册完成后会检查 `/api/chat/access`，没有 Agent/Chat 生成权限的账号默认不会放入可用生成池。

配置 YYDS key：

```bash
set YYDS_API_KEY=AC-your-key
```

也可以写入 `.env`：

```text
YYDS_API_KEY=AC-your-key
```

可选代理：

```bash
curl -X POST http://localhost:3000/api/config \
  -H "Content-Type: application/json" \
  -d "{\"key\":\"proxy_url\",\"value\":\"http://127.0.0.1:7890\"}"
```

启动一次注册：

```bash
curl -X POST http://localhost:3000/api/register
```

批量注册，单次最多 5 个：

```bash
curl -X POST http://localhost:3000/api/register/batch \
  -H "Content-Type: application/json" \
  -d "{\"count\":3,\"delay\":8000}"
```

注意：Quiver 可能允许临时邮箱登录，但仍返回 `credits=0`、`chat.enabled=false`、`explore.enabled=false`。本地代码不能凭空创建 Quiver 侧额度或权限；需要导入一个网页端本来就能生成的账号，`/v1/status` 才会变成 `ready:true`。

## Tampermonkey 导入

运行本地服务后安装辅助脚本：

```text
http://localhost:3000/quiver2api-export.user.js
```

安装后，在 `https://app.quiver.ai` 正常登录或注册。页面上的 Quiver2API 浮窗可以检查当前网页账号的 Chat/Agent 权限，并把 session 导入本地账号池。

脚本默认只向本地服务 `http://localhost:3000` 发送数据。如果浏览器阻止读取 HttpOnly `nuxt-session`，且 Tampermonkey 的 `GM_cookie` API 不可用，脚本仍然可以检查网页权限，但不能导入可复用的服务端 Cookie。

## 开源和安全

开源前请确认：

- 不提交 `.env`。
- 不提交 `accounts.db`。
- 不提交 `logs/`。
- 不提交截图、临时扫描目录或浏览器导出的 Cookie。
- `.env.example` 里只放占位符。

本项目适合本地自用或研究网页接口行为。使用时请遵守 Quiver 的服务条款、额度规则和当地法律法规。
