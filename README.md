<div align="center">

# API-Gateway

**One endpoint. Every model. Free tiers or paid SOTA — routing that learns.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js >=18](https://img.shields.io/badge/node.js-%3E%3D18-brightgreen.svg)](#quick-start)

[Quick Start](#quick-start) · [Features](#features) · [Using the API](#using-the-api) · [How It Works](#how-it-works) · [Bring Your Own Provider](#bring-your-own-provider)

</div>

---

## Why

Whether you're stacking free tiers from 18+ providers (~1.7 billion tokens per month across 100+ models) or routing paid premium models through a single intelligent endpoint — API-Gateway handles it the same way. Free or paid, one endpoint or twenty, the routing engine doesn't care. It learns which models deliver and routes accordingly.

**The problem:**

- Juggling dozens of SDKs, rate limits, and failure modes by hand
- One provider flakes and your app breaks
- Blow through a daily cap at 9 AM and discover it at noon
- Every key exhausted? Most gateways just give up and return an error
- No visibility into which model actually performed best for your workload

**API-Gateway solves this:**

- One OpenAI-compatible endpoint routes across every provider you configure — free tiers, paid APIs, or both mixed together
- An adaptive engine learns which models deliver and routes accordingly
- Per-key budget tracking *before* the request goes out — never blow through a cap again
- When every key is exhausted, it drops to recovery mode and self-heals — your app never sees an error
- A dashboard to manage keys, reorder your cascade, edit any model, and watch analytics in real time

## Features

| Feature | What it does | Why it matters |
| --- | --- | --- |
| **Adaptive routing engine** | Scores every model on reliability × speed × intelligence using Thompson sampling. Four presets: balanced, smartest, fastest, reliable. Or manual priority. | The router gets smarter the more you use it. No static list to maintain. |
| **Per-key budget tracking** | Tracks RPM, RPD, TPM, TPD per `(provider, model, key)` *before* the request goes out. | You never blow through a daily cap. The router always picks a key with capacity. |
| **Self-healing key rotation** | Three retries per key. When all keys are exhausted, drops to 1-RPM recovery mode — probing until one recovers. | Your app never sees an error, even when every key hits its daily limit. |
| **Intelligent cascade** | On 429, 5xx, or timeout: short cooldown on the key, cascade to the next model. Cooldowns are per-key, not per-model. | One rate-limited key never benches the whole provider. Other keys stay available. |
| **Context-aware selection** | Skips models with insufficient context window, no vision for images, or no tools for tool calls. | Your request never lands on a model that will mangle it. |
| **Sticky sessions** | Multi-turn conversations stay on the same model for 30 minutes. | No hallucination spike from mid-conversation model switches. |
| **Context handoff** | When a session must switch models, injects a compact system message so the new model knows it's continuing an existing task. | No "let me start over." Off by default; `API_GATEWAY_CONTEXT_HANDOFF=on_model_switch`. |
| **Key health monitoring** | Periodic probes mark keys healthy, rate-limited, invalid, or error. Successful requests promote keys back to healthy. | Dead keys are skipped automatically. The system recovers from transport hiccups without intervention. |
| **Concurrency gating** | Cap concurrent requests per provider. | A slow endpoint never starves faster ones of connection slots. |
| **Encrypted key storage** | AES-256-GCM before touching the database. Decryption in-memory at request time only. | Your provider keys never sit in plaintext. |
| **Error redaction** | Strips key fragments, account IDs, and internal URLs from provider error responses. | Sensitive data never leaks to your client. |
| **Unified API key** | Apps authenticate with a single `api-gateway-...` bearer token. | Provider keys never touch your application code. |
| **Tool call repair** | Automatic correction for JSON Schema mismatches and rescue for inline tool-call dialects. | Fewer broken tool loops. |
| **Embeddings with family routing** | `/v1/embeddings` routes by model family. Cascade only walks providers serving the same model. | Never silently corrupts your vector store by switching embedding models. |
| **Full config export/import** | One JSON file: models, cascade, providers, keys (optionally passphrase-encrypted), routing strategy, embeddings. Dry-run preview, atomic import with rollback. | Move your entire setup between machines safely. |

<details>
<summary><b>What's not supported yet</b></summary>

- Image generation (`/v1/images/*`)
- Audio / speech (`/v1/audio/*`)
- Legacy completions (`/v1/completions`) — only chat is implemented
- Moderation (`/v1/moderations`)
- `n > 1` (multiple completions per request)
- Per-user billing / multi-tenant auth — single-user by design

PRs welcome. See [Contributing](#contributing).

</details>

## Quick start

**Prerequisites:** Node.js 18+, npm.

```bash
git clone https://github.com/MLuqmanBR/api-gateway.git
cd api-gateway
npm install
cp .env.example .env

# Replace the placeholder encryption key with a real one
node -e "const c=require('crypto');const k=c.randomBytes(32).toString('hex');const fs=require('fs');let e=fs.readFileSync('.env','utf8');e=e.replace('ENCRYPTION_KEY=your-64-char-hex-key-here','ENCRYPTION_KEY='+k);fs.writeFileSync('.env',e);console.log('ENCRYPTION_KEY set to '+k)"

npm run dev
```

Open http://localhost:5173 (the Vite dev UI), add your provider keys on the **Keys** page, reorder your **model cascade** to taste, and grab your unified API key from the **Keys** page header. That unified key is what you point your OpenAI SDK at.

> **Reaching the dev UI from another device on your LAN?** Use `npm run dev:lan` — it passes `--host` through to Vite, which then prints a `Network: http://<your-ip>:5173` URL you can open from a phone or another machine. (Plain `npm run dev -- --host` does *not* work here: the root `dev` script is a `concurrently` wrapper, so the flag never reaches Vite.) API calls go through Vite's dev proxy, so no extra server config is needed.

For a production-like run (server + dashboard both served on `:3001`):

```bash
npm run build
node server/dist/index.js
```

### CLI (`api` command)

API-Gateway ships a CLI for managing the server as a background process:

```bash
# Make the `api` command available in your shell:
npm link

# Start/stop/restart the server in the background:
api start
api stop
api restart
api status
api logs
```

The CLI auto-builds on `api start` if the build is missing, reads the port from `.env`, and rotates the server log (capped at 50 MiB with 3 archived copies). For a full command list run `api help`.

`ENCRYPTION_KEY` is required for startup. The server only falls back to a database-stored development key when `NODE_ENV` is not `production`; do not use that fallback with real provider keys.

Request analytics are retained for 90 days or 100000 request rows by default, whichever limit prunes first. Set `REQUEST_ANALYTICS_RETENTION_DAYS=0` or `REQUEST_ANALYTICS_MAX_ROWS=0` in `.env` to disable either retention limit.

## Using the API

Any OpenAI-compatible client works. Point it at `http://localhost:3001/v1` and use your unified `api-gateway-...` key.

**Python**

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key="api-gateway-your-unified-key",
)

resp = client.chat.completions.create(
    model="auto",  # let the router pick; or specify e.g. "gemini-2.5-flash"
    messages=[{"role": "user", "content": "Summarise the fall of Rome in one sentence."}],
)
print(resp.choices[0].message.content)
print("Routed via:", resp.headers.get("x-routed-via"))
```

**curl**

```bash
curl http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer api-gateway-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

**Streaming**

```python
stream = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Stream me a haiku about SQLite."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

**Tool calling**

Pass OpenAI-style `tools` and `tool_choice`; the assistant response round-trips back through the proxy exactly like the OpenAI API. Multi-step flows (assistant `tool_calls` → `tool` role follow-up → final answer) work across every provider the router can reach.

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

# 1. Model asks for a tool call
first = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "What's the weather in Karachi?"}],
    tools=tools,
    tool_choice="required",
)
call = first.choices[0].message.tool_calls[0]

# 2. You execute the tool, feed the result back
final = client.chat.completions.create(
    model="auto",
    messages=[
        {"role": "user", "content": "What's the weather in Karachi?"},
        first.choices[0].message,
        {"role": "tool", "tool_call_id": call.id, "content": '{"temp_c": 32, "cond": "sunny"}'},
    ],
    tools=tools,
)
print(final.choices[0].message.content)
```

**Vision / image input**

Send images with the standard OpenAI `image_url` content blocks (base64 `data:` URLs or `http(s)` URLs). When a request contains an image, the router restricts itself to **vision-capable models** and ignores text-only ones. Vision models are tagged with a **Vision** badge on the cascade page.

```python
resp = client.chat.completions.create(
    model="auto",  # auto-routes to a vision model
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "What's in this image?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,<...>"}},
        ],
    }],
)
print(resp.choices[0].message.content)
```

If no vision-capable model is enabled in your cascade, an image request returns a clear `422` (`code: "no_vision_model"`) rather than silently dropping the image.

Every response carries an `X-Routed-Via: <platform>/<model>` header so you can see which provider actually served each call. If a request cascaded between providers, you'll also see `X-Fallback-Attempts: N`.

### Embeddings

`/v1/embeddings` is OpenAI-compatible, with one deliberate difference from chat routing: **the cascade never crosses models.** Vectors from different models live in incompatible spaces — silently switching models would corrupt any vector store built on top of the proxy. So embeddings route by **family** (one model identity + dimension), and the cascade only walks the providers serving that same family.

```python
resp = client.embeddings.create(
    model="auto",          # default family; or a family name like "bge-m3"
    input=["the quick brown fox", "pack my box with five dozen liquor jugs"],
)
print(len(resp.data), "vectors of", len(resp.data[0].embedding), "dims")
```

```bash
curl http://localhost:3001/v1/embeddings \
  -H "Authorization: Bearer api-gateway-your-unified-key" \
  -H "Content-Type: application/json" \
  -d '{"model": "auto", "input": "hello world"}'
```

`model` accepts `auto` (the configured default family), a family name, or a provider-specific model id (which resolves to its family). Available families:

| Family (`model`) | Dims |
| --- | --- |
| `gemini-embedding-001` *(default)* | 3072 |
| `text-embedding-3-large` | 3072 |
| `text-embedding-3-small` | 1536 |
| `embed-v4.0` | 1536 |
| `bge-m3` | 1024 |
| `qwen3-embedding-0.6b` | 1024 |
| `nv-embedqa-e5-v5` | 1024 |
| `llama-nemotron-embed-1b-v2` | 2048 |
| `llama-nemotron-embed-vl-1b-v2` | 2048 |
| `embeddinggemma-300m` | 768 |

The default family, per-provider toggles, and priorities live on the dashboard's **Models → Embeddings** page.

## Bring your own provider

Add any OpenAI-compatible or Anthropic-compatible HTTP endpoint as a provider — a paid SOTA API (frontier models from any lab), a local model server on your LAN, a free-tier cloud service, or anything in between. It gets the same adaptive routing, the same cascade behavior, the same per-key budget tracking as every built-in. From the dashboard's **Keys** page:

- **Add Provider** — slug, display name, base URL, API format (OpenAI or Anthropic), optional rate limits and concurrency caps.
- **Auto-discovery** — models are pulled from `/v1/models` on creation. Re-run anytime. Or register models manually.
- **Full model editing** — every model (built-in or custom) is editable: ranks, tools/vision flags, context window, rate limits. Changes take effect immediately.
- **Composite keys** — `account_id:api_key` format with `{account_id}` URL substitution for providers that need it.
- **Clean deletion** — removing a custom provider cascades: drops all models, keys, and cascade entries.

## Settings & backup

One versioned JSON envelope exports your entire configuration: models, cascade order, providers, keys (optionally passphrase-encrypted under PBKDF2-SHA256-310k + AES-256-GCM), routing strategy, and embedding families. Import with dry-run preview and atomic rollback.

<details>
<summary><b>Config API & merge modes</b></summary>

Endpoints behind `/api/config` (gated by dashboard session):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config/inventory` | Row counts per exportable section |
| `POST /api/config/export` | Build an envelope. Body: `{ sections, passphrase, label, download }` |
| `POST /api/config/preview` | Parse + validate without committing. Returns section counts and encryption status |
| `POST /api/config/import` | Apply an envelope. Body: `{ envelope, options: { mode, dryRun, passphrase, sections? } }`. Single SQLite transaction, atomic rollback. |

Merge modes:

- **skip-existing** *(default)* — never touch rows that already exist. Safest.
- **overwrite** — update existing rows in place, insert the rest.
- **replace** — wipe the destination section, then insert from the envelope.

Every import supports `dryRun: true` — runs inside a `SAVEPOINT`, rolls back, returns a diff summary. Always dry-run first against a populated database.

</details>

## How it works

```mermaid
flowchart LR
    Client["Your app<br/>OpenAI SDK / curl / any client"] -->|"Bearer api-gateway-…"| Gateway["Gateway :3001"]
    Gateway --> Router["Adaptive routing engine<br/>score · filter · pick best key"]
    Router --> Providers["Provider connectors<br/>18 built-in + custom"]
    Providers -->|"stream / JSON"| Gateway
    Providers -->|"429 / 5xx / timeout<br/>cascade to next"| Router
    Gateway -->|"response"| Client
```

1. Your app sends a request with a single `api-gateway-...` bearer token.
2. The routing engine scores every enabled model (Thompson-sampling Beta posterior for reliability, blended with speed and intelligence), filters out models that can't handle the request, and picks the best key with capacity.
3. On 429, 5xx, or timeout: cooldown the key, cascade to the next model. On total exhaustion: drop to 1-RPM recovery mode until a key recovers.
4. The response streams back with an `X-Routed-Via` header showing which provider served it.

<details>
<summary><b>Component map</b></summary>

| Subsystem | Source | Role |
| --- | --- | --- |
| Adaptive routing engine | `server/src/services/scoring.ts` + `router.ts` | Thompson sampling, context-aware selection, sticky sessions, concurrency gating |
| Per-key budget ledger | `server/src/services/ratelimit.ts` | In-memory RPM/RPD/TPM/TPD counters backed by SQLite, cooldowns |
| Self-healing key rotation | `server/src/services/key-exhaustion.ts` | 3-retry per key, key cycling, 1-RPM recovery mode |
| Key health monitoring | `server/src/services/health.ts` | Periodic probes, auto-promotion on success, reset on startup |
| Provider connectors | `server/src/providers/*.ts` | One per built-in; custom providers resolved at request time |
| Context handoff | `server/src/services/context-handoff.ts` | Session continuity on model switch, 3-hour TTL |
| Embeddings | `server/src/services/embeddings.ts` | Family-routed, same-model cascade only |
| Encryption | `server/src/lib/crypto.ts` + `error-redaction.ts` | AES-256-GCM key storage, provider error sanitization |
| Dashboard | `client/` | React + Vite + shadcn/ui |
| Storage | SQLite (`better-sqlite3`) | AES-256-GCM key encryption |

</details>

## When to use · When to skip

- Want to aggregate capacity across many providers behind one endpoint — free tiers, paid APIs, or both
- Are building an app and don't want to hardcode a single provider
- Want routing that adapts to real-world performance, not a static priority list
- Need your app to keep working when providers fail or rate-limit
- Want to mix free and paid models in one cascade (free for drafts, paid for hard problems)

**Skip it if you:**

- Need a managed cloud service — it's self-hosted only
- Need an admin dashboard for multiple operators — the gateway has one admin; multiple apps and clients can connect through it, but there's no multi-operator RBAC

## Contributing

```bash
npm install
npm run dev      # server on :3001, dashboard on :5173, both with HMR
npm test         # server vitest + client typecheck (tsc --noEmit)
npm run build    # compile server and dashboard
```

PRs should include a test, keep the existing test suite green, and match the `.editorconfig` / tsconfig defaults already in the repo. Issues and discussions are open.

## Disclaimer

**This project is for personal experimentation and learning, not production.** Free tiers exist so developers can prototype against them; they aren't a stable, supported inference substrate and shouldn't be treated as one. If you build something real on top of API-Gateway, swap in a paid API before you ship. Your relationship with each upstream provider is governed by the terms you accepted when you created your account — those terms still apply when the traffic is proxied through this project, and you're responsible for complying with them.

---

Built on [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi). Maintained by [MLuqmanBR](https://github.com/MLuqmanBR).

## License

[MIT](./LICENSE)
