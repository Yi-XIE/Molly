# Molly Personal Assistant

Molly is Yi's local-first personal assistant. A Windows personal node owns reasoning, memory, tools, and artifacts; a lightweight gateway connects Feishu without moving long-term memory to the cloud.

## Workspace

- `apps/desktop`: Electron + React conversation surface, task center, and artifact workspace.
- `apps/gateway`: Hono gateway for Feishu events, encrypted offline queueing, and node delivery.
- `packages/contracts`: shared task, event, artifact, and transport contracts.
- `packages/core`: SQLite task service, Pi SDK runtime adapter, memory boundary, and tool policy.
- `memory` and `evaluation`: the original memory experiment corpus and rubric.
- `hanaagent`: reference implementation only; Molly has no runtime dependency on it.

## Development

```powershell
npm install
npm run typecheck
npm test
npm run dev
```

`npm run dev:desktop` starts the Molly desktop application. `npm run dev:gateway` starts the local gateway on port 4317. Copy each app's `.env.example` to `.env` when connecting a real Feishu application or a remote gateway.

The original isolated Pi launcher remains available through `npm run pi`, and the memory experiment remains verifiable through `npm run validate`.

> Building the next generation of personal AI: Molly is a persistent, human-centered agent that helps you think, create, act, reflect, and grow across every part of life.
