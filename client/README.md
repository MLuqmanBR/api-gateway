# api-gateway dashboard (web client)

React 19 + TypeScript + Vite workspace for the api-gateway admin dashboard: keys and
platforms, fallback chains, budgets, privacy/redaction middle-layer config, analytics,
and the chat playground. It talks to the gateway server's `/api/*` (session-gated) and
`/v1/*` endpoints — see the repo root README for architecture details.

Commands (run from this directory, or with `npm run <cmd> -w client` from the repo root):

```sh
npm install        # once, from the repo root (npm workspaces)
npm run dev        # Vite dev server with HMR
npm run build      # type-check (tsc -b) + production build into dist/
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
```
