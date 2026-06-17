# Architecture Note

## Goal

Build a local-first web client for Obsidian vaults without collapsing the security boundary between a browser app and a local filesystem.

## Stack choice

- `apps/web`: React + Vite + TypeScript
- `apps/helper`: Fastify + TypeScript
- `packages/shared`: shared contracts used by both sides

This keeps the browser client lightweight and gives the local helper one clear job: expose only the minimum privileged operations needed to work with vault data.

## Runtime split

### Browser client

Owns:

- application shell
- navigation state
- note lists and previews
- plugin status UI
- future editor and workspace composition

Does not own:

- direct filesystem access
- executing arbitrary Obsidian plugins
- trusted access to native services

### Local helper

Owns:

- vault discovery
- note enumeration
- plugin manifest inspection
- future file read/write endpoints
- future plugin sandbox host

Does not own:

- primary UI rendering
- browser-side workspace state

## Plugin compatibility layer

The compatibility layer exists because most Obsidian plugins assume:

- the `obsidian` API package is present
- a desktop runtime can touch the vault directly
- plugin code can reach browser and Node-like primitives through the app

That assumption does not hold in a plain browser app. The replacement is a bridge with three pieces:

### 1. Shared contract

`packages/shared/src/contracts.ts` defines the stable surface between the web app and the helper:

- vault summaries
- vault details
- plugin manifest summaries
- compatibility capabilities
- plugin host status

This contract is intentionally narrow and versionable.

### 2. Browser adapter

The web app will eventually expose a browser-side adapter that emulates the safe subset of the Obsidian API:

- workspace events
- command registration
- metadata reads
- pane and view composition

Anything that needs vault I/O or process-level access stays out of this layer.

### 3. Helper-side plugin host

The helper is the only place allowed to mediate privileged plugin work. The intended progression is:

1. inspect plugin manifests
2. classify plugin compatibility
3. load selected plugins into a sandboxed runtime
4. expose only bridge-backed APIs

The scaffold implements steps 1 and 2.

## Compatibility model

Each plugin gets a coarse compatibility state:

- `native`: safe to emulate in the browser with the planned adapter
- `shimmed`: possible only through the bridge
- `unsupported`: depends on desktop-only behavior that the bridge should not fake

Initial heuristics are conservative. A plugin that expects filesystem mutation, Node modules, or desktop window APIs should default to `shimmed` or `unsupported` until proven otherwise.

## Why not run plugins directly in the browser

Because that would either:

- fail on Node and desktop assumptions, or
- force the app to overexpose local privileges into the page

Both are the wrong tradeoff. The helper process is where privileged code should be contained, audited, and sandboxed.

## Near-term next steps

1. add note read/write endpoints with optimistic locking
2. add a markdown editor and preview split
3. add a plugin sandbox process with explicit capability grants
4. mirror a small, well-defined subset of the `obsidian` API into the adapter
5. test against a short allowlist of simple community plugins

