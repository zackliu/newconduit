# Agent Runtime Sidecar POC

This repository contains a TypeScript framework for the Agent Runtime Sidecar POC. It is meant for people who are new to the project and need to understand how the central service, sidecar, and shared runtime contracts fit together.

The current POC is intentionally small: one central process, Docker workers, Azure Web PubSub as a long-lived connection layer, local file storage, and Copilot as the concrete agent process.

## What The POC Proves

- A client can request a durable session through central-owned runtime events.
- Central owns session truth, event logs, worker registry state, and snapshot metadata.
- Sidecar registers Docker-backed worker capacity and wraps a Copilot process.
- Worker selection uses `sidecarClass`, Worker labels, capacity, and conditions.
- Pause and resume use Docker volume snapshot/restore for both workspace and Copilot session history.
- Web PubSub is only the transport; it is not the source of truth and does not use upstream callbacks in this POC.

## Project Layout

All implementation code lives in `src/`.

```text
src/
  shared/
    models/       # AgentSpec, Session, Worker, Event, Snapshot, Audit
    contracts/    # Generic controller/storage/transport contracts
  central/
    registries/   # POC predefined class/profile registry
    storage/      # Central local file storage
    controllers/  # Replaceable central controllers
    adapters/     # Web PubSub, Docker hosting, Docker volume adapters
  sidecar/
    controllers/  # Worker registration, heartbeat, lease command handling
    adapters/     # Copilot process wrapper, Docker workspace, Web PubSub client
tests/
  central/         # Scenario-based central runtime tests
```

## Quick Start

Install dependencies:

```powershell
pnpm install
```

Build the project:

```powershell
pnpm build
```

Run tests:

```powershell
pnpm test
```

The test command compiles `tests/` into `dist-tests/` and runs Node's built-in test runner. Implementation code remains under `src/`.

The Web PubSub integration test reads `tests/.env`:

```text
WEBPUBSUB_ENDPOINT=https://chenylremoteagent.webpubsub.azure.com
WEBPUBSUB_HUB=agentruntimepoc
```

It uses `DefaultAzureCredential`, so run `az login` before enabling that test locally. The code does not use Web PubSub connection strings.

Start the central framework entrypoint:

```powershell
pnpm start:central
```

This starts the central HTTP server framework on `CENTRAL_PORT` or port `3000`. The current server exposes `/health`, `/client/negotiate`, and `/sidecar/negotiate`; it does not create a session on startup.

Start the sidecar framework entrypoint:

```powershell
pnpm start:sidecar
```

## Important Concepts

- `AgentSpec`: describes the Copilot POC agent and references predefined POC class/profile values.
- `SessionRecord`: durable session identity and lifecycle state owned by central.
- `WorkerRecord`: registered Docker-backed compute capacity created by sidecar registration.
- `RuntimeEvent`: append-only runtime fact used for routing and replay.
- `WorkspaceSnapshot`: metadata for a snapshot boundary containing the workspace volume and Copilot session volume.
- `CentralService`: central-facing runtime orchestration entrypoint.
- `SidecarDaemon`: worker-local wrapper around Docker volumes and Copilot process startup.

## Controller vs Adapter

Use this rule when adding files: controllers decide runtime state; adapters execute those decisions against a concrete technology.

| Category | Use it for | Examples |
| --- | --- | --- |
| Controller | Reads runtime facts and decides the next state, assignment, lease, event, or snapshot boundary. | `SessionLifecycleController`, `WorkerSelectionController`, `WorkerLeaseController`, `SnapshotController` |
| Adapter | Connects a controller decision to a concrete implementation such as Web PubSub, Docker, local files, or the Copilot process. | `WebPubSubTransportAdapter`, `DockerHostingAdapter`, `DockerVolumeAdapter`, `CopilotProcessAdapter` |
| Model | Defines the shape of durable resources and public contracts. | `SessionRecord`, `WorkerRecord`, `AgentSpec`, `RuntimeEvent` |
| Registry/Profile | Provides predefined POC class/profile configuration without advancing runtime state. | `POC_AGENT_SPEC`, POC class/profile registry |

For example, `WorkerSelectionController` is a controller because it decides which registered Worker should receive a session. It does not know whether that Worker is backed by Docker, Kubernetes, or a VM. `DockerHostingAdapter` is an adapter because it only performs the POC-specific act of starting a sidecar container.

The same boundary applies to pause and resume. `SnapshotController` decides that a pause boundary needs a workspace volume and Copilot session volume snapshot tied to an event cursor. `DockerVolumeAdapter` performs the actual copy and restore of those Docker volumes. `WebPubSubTransportAdapter` is also an adapter: Web PubSub is the POC transport, not the owner of session lifecycle or event truth.

`CentralHttpServer` is a generic HTTP server shell. It exposes route registration, but concrete routes such as `/health`, `/client/negotiate`, and `/sidecar/negotiate` are registered by the composition root in `src/central/main.ts`. Route handlers call central or tenant runtime APIs; they do not reach into transport adapters directly.

All barrel files must use explicit named exports. Do not use `export * from ...`; listing concrete classes and types keeps public contracts reviewable.

## Web PubSub Shape

POC Web PubSub usage is a simple client-connection pattern:

1. central, client, and sidecar connect as Web PubSub clients.
2. client and sidecar publish runtime events to the tenant inbox runtime channel.
3. central handles the event and writes local file storage first.
4. central publishes results to session-events and worker-commands runtime channels.

The shared transport contract uses runtime channels such as `tenant-inbox`, `session-events`, and `worker-commands`. Web PubSub group names such as `tenant:{tenantId}:central:events`, `tenant:{tenantId}:session:{sessionId}`, and `tenant:{tenantId}:worker:{workerId}` are adapter-internal mappings, not shared runtime contract fields.

Web PubSub upstream is not used.

## Validation Commands

The intended validation path is:

```powershell
pnpm install
pnpm build
pnpm test
```

After these commands are verified locally, keep this README and `AGENTS.md` in sync with any command changes.