# Agent Runtime Sidecar SDK

Customer-facing TypeScript SDK for Agent Runtime Sidecar sessions.

## Package Boundary

This package is released independently from the runtime service implementation. SDK source lives under `sdk/src/`. SDK tests live under `sdk/tests/`. The SDK does not import runtime code from `../src`.

The SDK follows the public protocol documented in [public-protocol-spec-ch.md](public-protocol-spec-ch.md).

## Build

```powershell
pnpm build
pnpm typecheck
pnpm test
```

## POC Usage

```ts
import { AgentRuntimeClient } from '@agent-runtime-sidecar/sdk';

const client = new AgentRuntimeClient({
  centralUrl: 'http://localhost:3000',
  tenantId: 'poc'
});

await client.connect();
const { session, turn } = await client.sessions.start({
  agent: 'copilot-poc',
  input: { message: 'hello' },
  workspace: { source: 'empty' }
});

const result = await turn.waitForResult();
await session.send({ message: `continue from turn ${result.turnSeq}` });
```