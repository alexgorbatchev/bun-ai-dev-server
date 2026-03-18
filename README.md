# bun-ai-dev-server

`bun-ai-dev-server` is an AI-agent-friendly development workflow for Bun apps.

Traditional hot reload and `--watch` are great for manual coding, but they break down when AI agents touch many files rapidly. You get frequent, unnecessary refreshes, UI interruptions, and reloads while you’re actively using the app.

This package solves that by separating **change detection** from **restart/reload**:
- a watch process tracks file updates and notifies your server
- the frontend subscribes to a change stream and shows a "changes available" state
- restart + page reload happen on demand (button or hotkey), when *you* decide

Result: fewer disruptive reloads, better UX during active sessions, and a much smoother agent-driven dev loop.

## Install

```bash
npm install --save-dev bun-ai-dev-server
```

## CLI usage

```bash
bun-ai-dev-server
```

Run a custom command:

```bash
bun-ai-dev-server -- bun run server/index.ts
```

### CLI environment variables

- `DEV_COMMAND` (default: `bun run server/index.ts`, unless CLI args are provided)
- `DEV_RESTART_EXIT_CODE` (default: `99`)
- `DEV_LABEL` (default: `dev`)
- `DEV_HINT` (default: unset / no hint)
- `NODE_ENV` (default: `development`)
- `PORT` (default: `3100`)
- `DEV_SERVER_URL` (default: `http://localhost:${PORT}`)
- `DEV_CHANGE_ENDPOINT_PATH` (default: `/api/dev/changes`)
- `DEV_WATCH` (default: enabled)
- `DEV_WATCH_ROOT` (default: current working directory)
- `DEV_WATCH_PATTERN` (default: `**/*.{ts,tsx,css,html,md}`)
- `DEV_WATCH_DEBOUNCE_MS` (default: `300`)
- `DEV_WATCH_GITIGNORE` (default: enabled)

## Reload button helpers

### 1) Server routes (Bun)

Export and mount these routes in your Bun server so the frontend button has restart + change stream endpoints.

```ts
import { createDevReloadRoutes } from 'bun-ai-dev-server';

Bun.serve({
  port: 3100,
  routes: {
    ...createDevReloadRoutes(),
  },
});
```

`createDevReloadRoutes()` defaults:
- `restartExitCode: 99`
- `restartEndpointPath: /api/dev/restart`
- `changeEndpointPath: /api/dev/changes`
- `restartDelayMs: 100`

### 2) Frontend controller

Use `createDevReloadClient()` to subscribe for dirty-state updates and trigger restart from a button.

```ts
import { useEffect, useMemo, useState } from 'react';
import { createDevReloadClient } from 'bun-ai-dev-server';

const devReloadClient = useMemo(() => createDevReloadClient(), []);
const [hasChanges, setHasChanges] = useState(false);

useEffect(() => devReloadClient.subscribe((event) => {
  setHasChanges(event.dirty);
}), [devReloadClient]);

useEffect(() => devReloadClient.installHotkey(), [devReloadClient]);

const onRestart = () => {
  void devReloadClient.restart();
};
```

`createDevReloadClient()` defaults match Date Maker behavior:
- enabled only on non-standard ports
- SSE stream: `/api/dev/changes`
- restart endpoint: `/api/dev/restart`
- hotkey: `Ctrl+Shift+X`
- reload delay: `1500ms`

## Development

```bash
bun install
bun run check
```

## Publish

```bash
bun run check
npm publish --access public
```
