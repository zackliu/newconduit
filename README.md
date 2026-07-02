# Agent Runtime Sidecar

Agent Runtime Sidecar is a runtime layer for running stateful, interactive agents as **durable online services**. Instead of treating an agent as a one-shot process, it treats each **session** as a durable identity that can be created, paused, recovered, and resumed across replaceable compute.

This repository is a working TypeScript POC of that runtime. A single **central** control plane owns session truth and routing, a **sidecar** wraps an existing agent process (GitHub Copilot SDK here) on a worker, **Azure Web PubSub** is the long-lived transport, and a **Docker WorkerPool** scales worker capacity on demand. The headline behavior it proves: you can chat with an agent, pause it (its worker is recycled), and later resume the same session on a brand-new worker that restores the workspace and the agent's own conversation memory.

## What It Does

- A client requests a durable session through central-owned runtime events; central owns the session catalog, event log, worker registry, and snapshot metadata.
- A **WorkerPool** scales Docker worker capacity when a session needs it; the sidecar inside each container registers as a Worker and runs the Copilot agent.
- Worker selection uses `sidecarClass`, Worker labels, capacity, and conditions — never a hard-coded machine address.
- **Pause** captures the workspace and the agent's session files into a session-addressed snapshot, then releases (and recycles) the worker.
- **Resume** scales out a fresh worker, restores the snapshot, and the Copilot process reattaches to its prior session, so the conversation continues on new compute.
- Web PubSub is only the transport; it is not the source of truth and does not use upstream callbacks.

## Project Structure

```text
src/
  shared/             # Cross-cutting contracts and durable models
    models/           # AgentSpec, Session, Worker, WorkerPool, RuntimeEvent, WorkspaceSnapshot, ...
    contracts/        # Storage, transport, clock, and controller contracts
    protocol/         # Runtime-channel <-> Web PubSub group mapping, HTTP route/query constants
  central/            # Service-provider runtime (the control plane)
    main.ts           # Composition root: builds the tenant runtime + Docker WorkerPool, starts the HTTP server
    central-service.ts, tenant-runtime.ts
    controllers/      # Protocol-facing ingress (client/worker/agent runtime events, tenant inbox)
    managers/         # Tenant-owned workflows, grouped by concern:
      session/        #   lifecycle, assignment, leases-on-session, event log, reconciler
      worker/         #   worker registry, selection, leases, WorkerPool scaling
      admission/      #   AgentSpec resolution into the frozen runtime contract
    persistence/      # Persistence classes selected by AgentSpec (volume snapshot vs copilot-managed-local)
    adapters/         # Web PubSub transport, Docker host pool (scale out/in containers)
    storage/          # Local file storage for sessions, events, workers, snapshots
    registries/       # Predefined POC AgentSpec / class registry
    http/             # Generic HTTP server shell + POC route registration
  sidecar/            # Worker-local process that adapts an agent into the runtime
    sidecar-daemon.ts # Receives worker commands; runs the per-turn agent loop; capture/restore on pause/resume
    adapters/         # Copilot SDK process wrapper, Docker workspace (mount + snapshot parts), Web PubSub client
sdk/client/           # Customer-facing TypeScript SDK (talks to central; never imports src/)
samples/webclient/    # Browser demo that drives durable sessions through the SDK
containers/sidecar/   # Dockerfile baked into the sidecar worker image
specs/                # POC workflow, runtime resource model, and implementation plan
tests/                # Scenario-based tests (central, sidecar, recovery, webpubsub, workerpool)
```

The central runtime keeps two role-based boundaries: **controllers** translate an external protocol (Web PubSub runtime events, sidecar commands) into tenant-internal commands, while **managers** own cohesive workflows and durable state (session lifecycle, assignment, leases, event log, worker registry, WorkerPool scaling). **Persistence classes** are selected by each AgentSpec to decide capture/restore (volume snapshot vs `copilot-managed-local`). **Adapters** execute a decision against a concrete technology (Web PubSub, Docker, local files, the Copilot process). `samples/webclient` and `sdk/client/` are customer-facing and never import `src/`.

## Prerequisites

- Node.js >= 20 and pnpm >= 9.
- Docker Desktop running (the WorkerPool builds and runs sidecar containers).
- An Azure Web PubSub resource.
- A Copilot-compatible model provider endpoint (Azure AI Foundry / Azure OpenAI / OpenAI-compatible).
- `az login` completed locally. Auth uses `DefaultAzureCredential` for both Web PubSub and the model provider; the WorkerPool mounts your host `~/.azure` profile into each sidecar container so the same login works inside Docker. No connection strings or committed tokens are used.

## Install and Build

```powershell
pnpm install
pnpm build
pnpm --dir sdk/client build
```

## Run the Central Server (with a Docker WorkerPool)

`pnpm start:central` runs the composition root in [src/central/main.ts](src/central/main.ts). It starts the HTTP server on port `3000` and **automatically configures one Docker WorkerPool** (`poc-docker-copilot`, labels `agent=copilot`, capacity 1) bound to the Docker host pool adapter. No separate worker process is needed — central scales workers itself.

```powershell
$env:WEBPUBSUB_ENDPOINT     = "https://<your-web-pubsub>.webpubsub.azure.com"
$env:WEBPUBSUB_HUB          = "agentruntimepoc"
$env:COPILOT_MODEL          = "<model-name>"
$env:COPILOT_PROVIDER_TYPE  = "openai"   # or "azure"
$env:COPILOT_PROVIDER_BASE_URL = "https://<provider-endpoint>"
pnpm start:central
```

On startup you should see `central service listening on http://localhost:3000`.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WEBPUBSUB_ENDPOINT` | yes | — | Azure Web PubSub endpoint (token auth via `DefaultAzureCredential`). |
| `WEBPUBSUB_HUB` | no | `agentruntimepoc` | Web PubSub hub name. |
| `COPILOT_MODEL` | yes (for agent turns) | — | Model id passed to the Copilot SDK session, forwarded to sidecars. |
| `COPILOT_PROVIDER_TYPE` | yes | — | `openai` (AI Foundry / OpenAI-compatible v1) or `azure` (Azure OpenAI resource). |
| `COPILOT_PROVIDER_BASE_URL` | yes | — | Provider endpoint passed to the Copilot SDK. |
| `TENANT_ID` | no | `poc` | Tenant runtime id. |
| `CENTRAL_PORT` | no | `3000` | HTTP port. |
| `RUNTIME_STORAGE_ROOT` | no | `.runtime-poc/tenants/<tenantId>` | Local storage root for sessions, events, workers, and snapshots. |
| `CENTRAL_URL_FOR_WORKERS` | no | `http://host.docker.internal:<port>` | URL the containerized sidecar calls back to reach central. |
| `CONFIG_DIR` | no | `config` | Directory of AgentSpec, WorkerPool, WorkerType, and host-pool-controller config documents read at startup. |

Optional provider knobs: `COPILOT_PROVIDER_TOKEN_SCOPE` (default `https://cognitiveservices.azure.com/.default`), `COPILOT_PROVIDER_WIRE_API` (`completions` or `responses`), and `COPILOT_PROVIDER_AZURE_API_VERSION`.

The demo AgentSpecs, WorkerPools, WorkerTypes, and host-pool controllers are declarative JSON documents under `config/` (not hardcoded in `src/`). Central reads `config/agent-specs/`, `config/worker-pools/`, and `config/host-pool-controllers/` at startup; a sidecar resolves `config/worker-types/<WORKER_TYPE>.json`. Each pool sets its own `scalePolicy.scaleInIdleMs`. A config document references adapters and persistence classes by a `*Class` id string that maps to an adapter/class's self-declared `classId` in code, so `src/` holds only generic lookup — no per-config-value branching.

## Run a Local Worker (no Docker)

A **worker type** names which `sidecarClass`, labels, capacity, and adapter classes a worker runs with; a worker startup only references a type. The `copilot-local` type runs Copilot directly on the worker host, lets Copilot manage its own workspace and session files, and exposes capacity 99 (many local sessions). With central running, start one in another shell:

```powershell
$env:CENTRAL_URL = "http://localhost:3000"
$env:TENANT_ID   = "poc"
$env:WORKER_TYPE = "copilot-local"
pnpm start:sidecar
```

This registers a worker with `sidecarClass=copilot-local-process`, `labels.agent=local`. Create a session against the `copilot-local` AgentSpec and central assigns it to this local worker without scaling a Docker pool. Pause stops that Copilot session and frees a capacity slot; resume reattaches Copilot to its prior session — there is no central snapshot, because the `copilot-managed-local` persistence class leaves continuity to Copilot.

## Run the Web Client and Drive a Durable Session

With central running, start the browser demo (Vite dev server on `http://127.0.0.1:5173`):

```powershell
pnpm --dir samples/webclient dev
```

Then, in the browser:

1. Set **Central URL** to `http://localhost:3000` and **Tenant** to `poc`, and click **Connect**. The right rail shows the `poc-docker-copilot` WorkerPool.
2. Click **Sessions +**, choose the `copilot-poc` AgentSpec, and click **Create Session**.
3. Central queues the session and the WorkerPool scales out a Docker worker: it builds [containers/sidecar/Dockerfile](containers/sidecar/Dockerfile), runs a container, the sidecar registers through `/sidecar/negotiate`, central assigns the session, and the Copilot agent starts. The session moves `queued → starting → running`.
4. Chat with the agent in the composer. Streamed output appears in the thread and runtime events appear in the grey rail.
5. Click **Pause**. The sidecar reaches a turn boundary, flushes the Copilot session files, and the workspace plus agent state are captured to a session-addressed snapshot under `<RUNTIME_STORAGE_ROOT>/snapshots/<sessionId>/<snapshotId>/`. Central records the snapshot, releases the lease, and the idle worker is scaled in (recycled).
6. Click **Resume**. Central re-queues the session, the WorkerPool scales out a **new** worker, the sidecar restores the snapshot before starting Copilot, and Copilot reattaches to its prior session. The agent can read files it created earlier and recall the conversation — on different compute.

> The first scale-out builds the sidecar image (a few minutes). Subsequent scale-outs reuse the cached image and start in seconds. Editing any file under `src/` invalidates the image's build layers, so the next scale-out rebuilds it.

## How Scaling and Recovery Work

- **Scale-out**: a queued session whose labels match the WorkerPool triggers the Docker host pool adapter to start a sidecar container. The container registers as a Worker; only after its first heartbeat does it become eligible for assignment.
- **Assignment**: central writes a `sessionLeaseId` and routes `session.assign` (with any restore reference) to the worker. The lease is how a durable session is bound to replaceable compute; stale-lease writes are rejected.
- **Scale-in**: after a session pauses or completes and a worker stays idle past `WORKER_POOL_SCALE_IN_IDLE_MS`, the WorkerPool closes the worker and stops the container.
- **Snapshots are session-addressed**: they are filed under the durable `sessionId`, not under any worker, so recovery only needs the session identity. Central owns the snapshot record and `latestSnapshotRef`; the sidecar moves the bytes (capture on pause, restore on resume).

## Tests

```powershell
pnpm typecheck
pnpm test
```

`pnpm test` compiles `tests/` to `dist-tests/` and runs Node's built-in test runner. The Web PubSub integration tests and the real Copilot smoke test read `tests/.env` and use `DefaultAzureCredential`, so run `az login` to exercise them; otherwise they are skipped.

The full Docker WorkerPool end-to-end validation (scale-out, an agent turn, pause + snapshot, recycle, resume + restore) is opt-in because it builds an image and starts real containers:

```powershell
$env:RUN_DOCKER_WORKERPOOL_E2E = '1'
node -e "require('fs').rmSync('dist-tests', { recursive: true, force: true })"
pnpm exec tsc -p tsconfig.test.json
node --test dist-tests/tests/workerpool/docker-workerpool.integration.test.js
```

This requires Docker Desktop, `az login`, the `tests/.env` Web PubSub settings, and the Copilot provider env. A deterministic, always-on version of the same continuity scenario (worker recycle → restore → recall) runs in-process as part of `pnpm test`.
