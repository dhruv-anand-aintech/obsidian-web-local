# Obsidian Web Local

`obsidian-web-local` is a local-first browser client for Obsidian vaults. It keeps the UI in the browser, keeps filesystem access inside a small local helper, and makes plugin compatibility an explicit bridge instead of pretending the full desktop runtime exists in the page.

## What this scaffold includes

- A React + Vite + TypeScript browser app in `apps/web`
- A Fastify + TypeScript local helper in `apps/helper`
- Shared RPC and compatibility types in `packages/shared`
- Vault discovery for folders that contain `.obsidian`
- Note and plugin manifest listing for discovered vaults
- A documented compatibility layer boundary for Obsidian plugins

## Layout

```text
apps/
  helper/   Local vault bridge and plugin host boundary
  web/      Browser client
packages/
  shared/   Shared types and compatibility contracts
docs/
  architecture.md
```

## Prerequisites

- Node.js 20+
- npm 10+

## Run

Install dependencies:

```bash
npm install
```

Point the helper at one or more vault roots. The helper treats any directory with a `.obsidian` folder as a vault and also scans one level below each root. Prefer passing the specific vault folder rather than a large source-code directory.

```bash
export OBS_VAULT_ROOTS="$HOME/Documents/Obsidian/MyVault"
export OBSIDIAN_WEB_LOCAL_PORT=3002
export OBSIDIAN_WEB_LOCAL_WEB_PORT=5174
```

Start both processes:

```bash
npm run dev
```

Endpoints for the current local run:

- Web UI: `http://127.0.0.1:5174`
- Helper API: `http://127.0.0.1:3002`

Build everything:

```bash
npm run build
```

Launch the packaged local app from built assets:

```bash
npm run launch -- --vault-roots "$HOME/Documents/Obsidian/MyVault"
```

The launcher starts the helper API, serves the web client, proxies `/api`, and opens a browser tab by default.

- Web UI: `http://127.0.0.1:38200`
- Helper API: `http://127.0.0.1:38201`
- Disable browser launch: `npm run launch -- --no-open`
- Custom ports: `npm run launch -- --port 4000 --helper-port 4001`
- Binary entrypoint after install/link: `obsidian-web-local --vault-roots "$HOME/Documents/Obsidian/MyVault"`

Type-check everything:

```bash
npm run typecheck
```

## Current capabilities

- Vault discovery and note listing
- Plugin manifest discovery and coarse compatibility classification
- Raw note fetch through the local helper
- A generalized note renderer registry in the browser
- A working Kanban renderer for notes that expose `viewTypes: ["kanban"]`

## Current limitations

- This is still not a drop-in replacement for the Obsidian desktop runtime.
- Plugin execution is not enabled yet. The helper exposes compatibility metadata and the runtime boundary, not full plugin loading.
- Editing, indexing, search, sync, and conflict handling are still open work.

## Plugin compatibility layer

The compatibility boundary is described in [docs/architecture.md](./docs/architecture.md). The short version:

1. The browser app owns UI state and rendering.
2. The helper owns filesystem access and any privileged plugin operations.
3. Plugins only talk to a constrained adapter surface, not raw Node APIs or the browser directly.
