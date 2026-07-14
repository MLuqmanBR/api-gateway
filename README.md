<div align="center">

# API-Gateway

**One endpoint. Every model. Routing that learns.**

Route across every free-tier provider and any custom endpoint through a single OpenAI-compatible API — with an adaptive routing engine that learns from real outcomes, keys that self-heal, encryption by default, and a dashboard that controls everything.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js >=20](https://img.shields.io/badge/node.js-%3E%3D20-brightgreen.svg)](#quick-start)

![API-Gateway dashboard](repo-assets/desktop.png)

</div>

---

## Contents

- [The problem with running multiple models](#the-problem-with-running-multiple-models)
- [Supported providers](#supported-providers)
- [What makes it different](#what-makes-it-different)
- [Quick start](#quick-start)
- [Using the API](#using-the-api)
- [Bring your own provider](#bring-your-own-provider)
- [Settings & backup](#settings--backup)
- [How it works](#how-it-works)
- [Dashboard](#dashboard)
- [What's not supported yet](#whats-not-supported-yet)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [License](#license)

## The problem with running multiple models

Every serious AI lab offers a free tier — millions of tokens a month, thousands of requests a day. On its own, each tier is a toy. Stacked together, they add up to roughly **1.7 billion tokens per month** of working inference capacity across 100+ models, from small-and-fast to frontier-class reasoning.

The problem is that stacking them by hand is painful. A dozen different SDKs, a dozen different rate limits, a dozen places a request can fail. One provider flakes and your app breaks. You become a full-time infrastructure manager instead of building your product.

API-Gateway collapses all of that — every free tier, every custom endpoint, every local model — into one OpenAI-compatible endpoint. Point any OpenAI client library at your local server, and it routes transparently across whichever providers you've configured. When one fails, it cascades to the next. When every key is exhausted, it waits patiently and recovers on its own. You write one integration. The gateway handles the rest.

## Supported providers

18 providers are built in — major cloud platforms, specialized inference engines, community gateways, and aggregators. Each gets the same adaptive routing, the same per-key budget tracking, and the same cascade behavior as every other. 14 require an API key; 4 work anonymously with no key at all.

The catalog spans the full spectrum of what's available for free today:

- **Frontier-class reasoning** — large-parameter models from the latest generation of open and proprietary model families
- **Ultra-low-latency inference** — purpose-built inference engines that serve tokens faster than anything else
- **Aggregators** — meta-routers that expose dozens of upstream models behind a single endpoint
- **Cloud platform tiers** — free inference access from major cloud and edge providers
- **Community gateways** — independent projects offering anonymous, no-key access to open models

Models from Llama, GPT-OSS, Qwen, GLM, Gemini, Command, DeepSeek, Kimi, and many more are all represented. New providers and models are added regularly as free tiers emerge.

Don't see yours? Any OpenAI-compatible or Anthropic-compatible HTTP endpoint becomes a provider in under a minute — see [Bring your own provider](#bring-your-own-provider).

## What makes it different

Most gateways route the same way every time: try provider A, then B, then C. If A is rate-limited, you wait. If every key is exhausted, you get an error. API-Gateway doesn't work that way.

### Routing that learns

- **Adaptive routing engine** — Routes to the best available model by learning from real outcomes (reliability x speed x intelligence), not a static list. Uses Thompson sampling: a Beta-distribution posterior that explores uncertain models and exploits proven ones. Four presets — balanced, smartest, fastest, reliable — or switch to manual priority ordering anytime. The router gets smarter the more you use it.

- **Context-aware model selection** — Skips models whose context window can't hold the request, models that lack vision when an image is present, and models that can't emit tool calls when tools are requested. Your request never lands on a model that will mangle it.

- **Sticky sessions** — Multi-turn conversations stay on the same model for 30 minutes to avoid the hallucination spike that comes from mid-conversation model switches.

- **Context handoff** — When a session must switch models mid-conversation, a compact system message tells the new model it's continuing an existing task — no "let me start over." Off by default; enable with `API_GATEWAY_CONTEXT_HANDOFF=on_model_switch`.

### Resilience by design

- **Per-key budget tracking** — Tracks RPM, RPD, TPM, and TPD per `(provider, model, key)` *before* the request goes out, not after. The router always picks a key with capacity left — you never blow through a daily cap at 9 AM and discover it at noon.

- **Self-healing key rotation** — Three retries per key on transient failures. When every key for a model is exhausted, the router drops to recovery mode — probing each key once per minute until one recovers, then resumes normal operation. Your app never sees an error.

- **Intelligent cascade** — On 429, 5xx, or timeout, the router puts the key on a short cooldown and cascades to the next model. Cooldowns are per-key, not per-model — so one rate-limited key never benches the whole provider.

- **Key health monitoring** — Periodic probes mark keys as healthy, rate-limited, invalid, or error. Dead keys are skipped automatically. A key that successfully serves a request is promoted back to healthy. The system recovers from transport hiccups without operator intervention.

- **Provider concurrency gating** — Cap concurrent requests per provider so a slow endpoint never starves faster ones of connection slots. Your fast connections stay fast even when a slow model is chewing on a long prompt.

### Security first

- **Encrypted key storage** — API keys are encrypted with AES-256-GCM before touching the database. Decryption happens in-memory, only at request time. Your provider keys never sit in plaintext.

- **Error redaction** — Provider error responses sometimes leak key fragments, account IDs, or internal URLs. API-Gateway strips those before they reach your client.

- **Unified API key** — Your apps authenticate with a single `api-gateway-...` bearer token. Provider keys never touch your application code.

- **Full configuration export/import** — One JSON file carries your entire setup: models, cascade order, providers, keys (optionally passphrase-encrypted under PBKDF2-SHA256-310k + AES-256-GCM), routing strategy, embedding families. Dry-run preview, atomic import with rollback.

- **Tool call repair** — Automatic correction for common JSON Schema mismatches and a rescue system for inline tool-call dialects some providers emit. Fewer broken tool loops.

- **Embeddings with family routing** — `/v1/embeddings` routes by model family; cascade only walks providers serving the same model. Vectors from different models are incompatible — the gateway never silently corrupts your vector store.

## Quick start

**Prerequisites:** Node.js 20+, npm.

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

The built-in list is a starting point, not a boundary. Any HTTP endpoint that speaks OpenAI or Anthropic format becomes a provider — a cloud service, a local model server on your LAN, a vLLM server on your homelab, a paid API you have credits for.

From the dashboard's **Keys** page, the provider catalog is the unified grid. The **Add Provider** tile opens a form for:

- **Slug** — a short identifier like `my-local-llm` (lowercase letters, digits, dashes; 2-32 chars; cannot collide with a built-in).
- **Display name** — shown in the dashboard.
- **Base URL** — the endpoint, e.g. `http://192.168.1.10:8080/v1`.
- **API format** — OpenAI or Anthropic. Both are fully supported.
- **Rate limits** (optional) — RPM, RPD, TPM, TPD caps enforced per-provider.
- **Max parallel requests** (optional) — concurrency ceiling so this provider never hogs all connection slots.

Once a provider exists, its models are auto-discovered from the endpoint's `/v1/models` during creation. You can re-run discovery at any time. Or register models manually with the **Add a model** form — set the model ID, context window, tools/vision flags, intelligence rank, speed rank, and rate limits.

Every model — built-in or custom — is editable from the dashboard. Adjust ranks, toggle tools/vision, cap output tokens, change rate limits. Changes take effect immediately, no restart needed.

Adding an API key works the same as for a built-in provider: pick the custom slug, paste the bearer token (or leave blank for local servers that don't need one). For providers that use composite keys, the `account_id:api_key` format is supported with `{account_id}` URL substitution in the base URL.

Deleting a custom provider cascades cleanly — it drops every model on that platform, every key, and every cascade entry. No orphaned models.

## Settings & backup

The **Settings** page backs up the entire gateway configuration and restores it elsewhere — useful when you promote a curated setup from your laptop to a server, sync between staging and production, or recover from a wipe.

One versioned JSON envelope carries:

- Every model in the catalog with its ranks, capabilities, rate limits, context window, max output tokens, and vision/tools flags.
- The full cascade order (ordered list of `(platform, model_id)` pairs with their enabled state).
- All custom providers and their base URLs, rate limits, max-parallel ceiling, keyless/api-format flags.
- Every API key — optionally encrypted under a passphrase you supply at export time (PBKDF2-SHA256-310k-derived AES-256-GCM ciphertext). Safe to commit to a private repo or drop in a chat.
- Embedding family configuration (per-family provider order, dimensions, default family).
- Routing strategy, custom weights, and global retry limit.
- Your authored quirks (title, body, severity, per-target model globs).

Three endpoints sit behind `/api/config` (gated by the dashboard session):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/config/inventory` | Row counts per exportable section. The Settings page calls this on load. |
| `POST /api/config/export` | Build an envelope. JSON body may include `sections`, `passphrase`, `label`, `download`. |
| `POST /api/config/preview` | Parse and validate an envelope without committing. Returns parsed section counts, schema version, and whether keys are encrypted. |
| `POST /api/config/import` | Apply an envelope. Body: `{ envelope, options: { mode, dryRun, passphrase, sections? } }`. Runs inside a single SQLite transaction; rolls back atomically on any structural error. |

### Merge modes

- **skip-existing** *(default)* — never touch rows that already exist. New rows are inserted. Safest when restoring into a populated database.
- **overwrite** — update existing rows in place, insert the rest.
- **replace** — wipe the destination section, then insert from the envelope.

### Dry-run

Every import can be sent with `dryRun: true`. The server runs the exact same code path inside a SQLite `SAVEPOINT`, then rolls back. The response includes a `diff` summary — for each section, how many records were added, updated, skipped, or removed, plus any per-record errors. Always dry-run first when applying against a populated database.

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
2. The gateway decrypts the token, resolves the session, and hands the request to the routing engine.
3. The engine scores every enabled model using a Thompson-sampling Beta posterior (reliability) blended with deterministic speed and intelligence scores, then applies guardrails: per-key budget headroom and live rate-limit penalty.
4. Models that can't handle the request are filtered out — wrong context window, no vision for images, no tools for tool calls, keys on cooldown, keys at their rate limit.
5. The best surviving key is picked, decrypted in-memory, and the request is sent to the provider.
6. On 429, 5xx, or timeout, the key goes on a short cooldown and the router cascades to the next model. On total exhaustion, it drops to recovery mode — probing once per minute until a key recovers.
7. The response streams back to your client with an `X-Routed-Via` header showing which provider served it.

**Component map:**

- **Adaptive routing engine** — `server/src/services/scoring.ts` + `server/src/services/router.ts` (Thompson sampling, context-aware selection, sticky sessions, concurrency gating).
- **Per-key budget ledger** — `server/src/services/ratelimit.ts` (in-memory RPM/RPD/TPM/TPD counters backed by SQLite, with cooldowns).
- **Self-healing key rotation** — `server/src/services/key-exhaustion.ts` (3-retry per key, key cycling, 1-RPM recovery mode).
- **Key health monitoring** — `server/src/services/health.ts` (periodic probes, auto-promotion on success, reset on startup).
- **Provider connectors** — `server/src/providers/*.ts` (one per built-in; custom providers resolved at request time from the `custom_providers` table).
- **Context handoff** — `server/src/services/context-handoff.ts` (session continuity on model switch, 3-hour TTL).
- **Embeddings** — `server/src/services/embeddings.ts` (family-routed, same-model failover only).
- **Encryption** — `server/src/lib/crypto.ts` (AES-256-GCM), `server/src/lib/error-redaction.ts` (provider error sanitization).
- **Dashboard** — `client/` (React + Vite + shadcn/ui).
- **Storage** — SQLite (`better-sqlite3`) with AES-256-GCM key encryption.

## Dashboard

![Keys](repo-assets/keys.png)

Manage provider credentials, add custom providers, and grab the unified API key your apps connect with. Each key shows a live status dot and when it was last health-checked.

![Playground](repo-assets/playground.png)

Send a chat completion through the router and see which provider served it, with the model ID and latency printed right on the message.

![Analytics](repo-assets/analytics.png)

Request volume, success rate, tokens in and out, average latency, and per-provider breakdowns over 24h, 7d, and 30d windows.

## What's not supported yet

- **Image generation** (`/v1/images/*`)
- **Audio / speech** (`/v1/audio/*`)
- **Legacy completions** (`/v1/completions`) — only the chat endpoint is implemented
- **Moderation** (`/v1/moderations`)
- **`n > 1`** (multiple completions per request)
- **Per-user billing / multi-tenant auth** — single-user by design

PRs that add any of these are welcome. See [Contributing](#contributing).

## Limitations

Stacking free tiers — even with custom providers in the mix — has real trade-offs:

- **No frontier models out of the box.** The free-tier catalog tops out around Llama 3.3 70B, GLM-4.5, Qwen 3 Coder, and Gemini 2.5 Pro. You won't get GPT-5 or Claude Opus class reasoning through the built-in providers. For hard problems, pay for a real API — or bring your own paid provider as a custom endpoint.
- **Intelligence degrades as the day progresses.** Your top-ranked models have the lowest daily caps. Once they hit their limits, the router falls down your cascade to smaller, weaker models. Expect the effective intelligence to drop in the late hours — then reset at UTC midnight.
- **Latency is highly variable.** Some providers are extremely fast; others are not. You get whichever one is available at the moment.
- **Free tiers can change without notice.** Providers regularly tighten, loosen, or remove free tiers. When that happens you'll see 429s or auth errors until the catalog catches up.
- **No SLA, by definition.** If you need reliability, use a paid provider with a contract — either directly or plugged in as a custom endpoint.

## Contributing

Contributors welcome. The development loop:

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
