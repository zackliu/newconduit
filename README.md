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
    controllers/  # Protocol-facing replaceable ingress controllers
    managers/     # Tenant-owned runtime workflows and state mechanisms
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

The test command clears stale `dist-tests/` output, compiles `tests/` into `dist-tests/`, and runs Node's built-in test runner. Implementation code remains under `src/`.

The Web PubSub integration test reads `tests/.env`:

```text
WEBPUBSUB_ENDPOINT=https://chenylremoteagent.webpubsub.azure.com
WEBPUBSUB_HUB=agentruntimepoc
```

It uses `DefaultAzureCredential`, so run `az login` before enabling that test locally. The code does not use Web PubSub connection strings.

Start the central framework entrypoint:

```powershell
$env:WEBPUBSUB_ENDPOINT="https://<your-web-pubsub-name>.webpubsub.azure.com"
$env:WEBPUBSUB_HUB="agentruntimepoc"
$env:TENANT_ID="poc"
pnpm start:central
```

`WEBPUBSUB_ENDPOINT` is required. `WEBPUBSUB_HUB` defaults to `agentruntimepoc`, `TENANT_ID` defaults to `poc`, `CENTRAL_PORT` defaults to `3000`, and `RUNTIME_STORAGE_ROOT` defaults to `.runtime-poc/tenants/<tenantId>`. The current server exposes `/health`, `/client/negotiate`, and `/sidecar/negotiate`; it does not create a session on startup.

Start the sidecar framework entrypoint:

```powershell
$env:CENTRAL_URL="http://localhost:3000"
$env:TENANT_ID="poc"
$env:SIDECAR_WORK_ROOT=".runtime-poc/sidecar"
pnpm start:sidecar
```

`CENTRAL_URL` is required for the sidecar. `TENANT_ID` must match the central tenant and defaults to `poc`. `SIDECAR_WORK_ROOT` is optional; it controls where the sidecar prepares local workspace and Copilot session-state directories.

The sidecar wraps the Copilot SDK process. For GitHub-backed Copilot auth, set one of these in your shell before starting the sidecar: `COPILOT_GITHUB_TOKEN`, `GITHUB_TOKEN`, or `GH_TOKEN`. Do not commit token values to the repo.

If the Copilot SDK session should use an explicit provider endpoint, set these sidecar env vars as a group:

```powershell
$env:COPILOT_PROVIDER_BASE_URL="https://<provider-endpoint>"
$env:COPILOT_MODEL="<model-name>"
$env:COPILOT_PROVIDER_TYPE="azure" # or "openai"
```

Optional provider knobs are `COPILOT_PROVIDER_TOKEN_SCOPE` (defaults to `https://cognitiveservices.azure.com/.default`), `COPILOT_PROVIDER_WIRE_API` (`completions` or `responses`), and `COPILOT_PROVIDER_AZURE_API_VERSION`. Azure provider auth uses `DefaultAzureCredential`, so run `az login` locally unless the sidecar runs with managed identity. `COPILOT_CLI_PATH` can point at a specific Copilot CLI runtime path when needed.

## Important Concepts

- `AgentSpec`: describes the Copilot POC agent and references predefined POC class/profile values.
- `SessionRecord`: durable session identity and lifecycle state owned by central.
- `WorkerRecord`: registered Docker-backed compute capacity created by sidecar registration.
- `RuntimeEvent`: append-only runtime fact used for routing and replay.
- `WorkspaceSnapshot`: metadata for a snapshot boundary containing the workspace volume and Copilot session volume.
- `CentralService`: central-facing runtime orchestration entrypoint.
- `SidecarDaemon`: worker-local wrapper around Docker volumes and Copilot process startup.

## Controller, Manager, Adapter

Use this rule when adding files: controllers represent replaceable protocol or ingress boundaries, managers own cohesive runtime workflows and state mechanisms, and adapters execute decisions against a concrete technology.

| Category | Use it for | Examples |
| --- | --- | --- |
| Controller | Translates an external protocol or ingress shape into tenant-internal commands. It is replaceable when the ingress protocol changes. | `TenantInboxController`, `ClientRuntimeEventController`, `WorkerRuntimeEventController` |
| Manager | Owns a tenant-internal workflow, state transition, sequence, assignment, lease, event log, or registry mechanism. It does not represent a replaceable protocol boundary. | `SessionManager`, `SessionLifecycleManager`, `SessionAssignmentManager`, `SessionLeaseManager`, `WorkerManager`, `EventLogManager` |
| Policy/selector | Makes a pure selection or policy decision without owning protocol ingress or durable state writes. | `WorkerSelector` |
| Adapter | Connects a controller decision to a concrete implementation such as Web PubSub, Docker, local files, or the Copilot process. | `WebPubSubTransportAdapter`, `DockerHostingAdapter`, `DockerVolumeAdapter`, `CopilotProcessAdapter` |
| Model | Defines the shape of durable resources and public contracts. | `SessionRecord`, `WorkerRecord`, `AgentSpec`, `RuntimeEvent` |
| Registry/Profile | Provides predefined POC class/profile configuration without advancing runtime state. | `POC_AGENT_SPEC`, POC class/profile registry |

For example, `ClientRuntimeEventController` is a controller because it accepts Web PubSub runtime events and translates them into session commands. `SessionManager` is a manager because it owns the create/input workflow and coordinates session lifecycle, event log, turn sequence, and assignment managers. `WorkerSelector` is a selector because it only chooses a compatible Worker from facts it is given. `DockerHostingAdapter` is an adapter because it only performs the POC-specific act of starting a sidecar container.

The same boundary applies to pause and resume. A protocol controller should translate `session.pause.requested` or `session.resume.requested` into a tenant-internal command. Managers decide the lifecycle, lease, snapshot, recovery, and event-log effects. `DockerVolumeAdapter` performs the actual copy and restore of Docker volumes. `WebPubSubTransportAdapter` is also an adapter: Web PubSub is the POC transport, not the owner of session lifecycle or event truth.

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