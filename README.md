# Agent Runtime Sidecar

Agent Runtime Sidecar is a runtime layer for running stateful, interactive agents as **durable online services**. Instead of treating an agent as a one-shot process, it treats each **session** as a durable identity that can be created, paused, recovered, and resumed across replaceable compute.

This repository is a working TypeScript POC of that runtime. A single **central** control plane owns session truth and routing, a **sidecar** wraps an existing agent process (GitHub Copilot SDK here) on a worker, **Azure Web PubSub** is the long-lived transport, and a **Docker WorkerPool** scales worker capacity on demand. The headline behavior it proves: you can chat with an agent, pause it (its worker is recycled), and later resume the same session on a brand-new worker that restores the workspace and the agent's own conversation memory.

## What It Does

- A client requests a durable session through central-owned runtime events; central owns the session catalog, event log, worker registry, and snapshot metadata.
- A **WorkerPool** scales Docker worker capacity when a session needs it; the sidecar inside each container registers as a Worker and runs the Copilot agent.
- Worker selection uses Worker labels (including a `storage` capability label), capacity, and conditions — never a hard-coded machine address.
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
- Docker Desktop running (the WorkerPool runs pre-built sidecar containers).
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

`pnpm start:central` runs the composition root in [src/central/main.ts](src/central/main.ts). It starts the HTTP server on port `3000` and **automatically configures one Docker WorkerPool** (`poc-docker-copilot`, labels `agent=copilot`, capacity 1) bound to the Docker host pool adapter. No separate worker process is needed — central scales workers itself. Because building an image is not a runtime step, build the sidecar image once first with `pnpm build:sidecar-image` (Docker required); the WorkerPool only runs that pre-built image.

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
| `CENTRAL_URL_FOR_WORKERS` | no | `http://host.docker.internal:<port>` | Default URL a worker's sidecar calls back to reach central. A host-pool-controller can override it per backend with its own `centralUrlForWorkers` (e.g. a public URL for cloud workers). |
| `CONFIG_DIR` | no | `config` | Directory of AgentSpec, WorkerPool, and host-pool-controller config documents read at startup. |

Optional provider knobs: `COPILOT_PROVIDER_TOKEN_SCOPE` (default `https://cognitiveservices.azure.com/.default`), `COPILOT_PROVIDER_WIRE_API` (`completions` or `responses`), and `COPILOT_PROVIDER_AZURE_API_VERSION`.

The demo AgentSpecs, WorkerPools, and host-pool controllers are declarative JSON documents under `config/` (not hardcoded in `src/`). Central reads `config/agent-specs/`, `config/worker-pools/`, and `config/host-pool-controllers/` at startup. Worker types are image-declared code build profiles ([src/sidecar/worker-types.ts](src/sidecar/worker-types.ts)), not config — they only name the adapter combination the image ships. Matching is pure labels: an AgentSpec's `workerSelector.matchLabels` (including a `storage` capability label) is matched against worker labels; a worker reports its concrete `storageClass` driver at registration, and snapshots are opaque handle envelopes. Each pool sets its own `scalePolicy.scaleInIdleMs`.

## Run a Local Worker (no Docker)

A **worker type** is an image-declared build profile that names the adapter combination a worker runs with (storage data-half + agent process); worker startup references a type by id. The `copilot-local` type runs Copilot directly on the worker host, lets Copilot manage its own workspace and session files, and (with capacity 99) hosts many local sessions. Matching is by labels, so a standalone worker passes its labels and capacity explicitly. With central running, start one in another shell:

```powershell
$env:CENTRAL_URL = "http://localhost:3000"
$env:TENANT_ID   = "poc"
$env:WORKER_TYPE = "copilot-local"
$env:SIDECAR_LABELS_JSON = '{"agent":"local","storage":"host-managed"}'
$env:SIDECAR_CAPACITY = "99"
pnpm start:sidecar
```

This registers a worker with `labels.agent=local`, `storage=host-managed`, backed by the `host-managed` storage driver. Create a session against the `copilot-local` AgentSpec and central assigns it to this local worker (pure-label match) without scaling a Docker pool. Pause stops that Copilot session and frees a capacity slot; resume reattaches Copilot to its prior session — there is no central snapshot, because the host-managed storage driver leaves continuity to Copilot.

## Run the Web Client and Drive a Durable Session

With central running, start the browser demo (Vite dev server on `http://127.0.0.1:5173`):

```powershell
pnpm --dir samples/webclient dev
```

Then, in the browser:

1. Set **Central URL** to `http://localhost:3000` and **Tenant** to `poc`, and click **Connect**. The right rail shows the `poc-docker-copilot` WorkerPool.
2. Click **Sessions +**, choose the `copilot-poc` AgentSpec, and click **Create Session**.
3. Central queues the session and the WorkerPool scales out a Docker worker: it runs a container from the pre-built sidecar image ([containers/sidecar/Dockerfile](containers/sidecar/Dockerfile), built via `pnpm build:sidecar-image`), the sidecar registers through `/sidecar/negotiate`, central assigns the session, and the Copilot agent starts. The session moves `queued → starting → running`.
4. Chat with the agent in the composer. Streamed output appears in the thread and runtime events appear in the grey rail.
5. Click **Pause**. The sidecar reaches a turn boundary, flushes the Copilot session files, and the workspace plus agent state are captured to a session-addressed snapshot under `<RUNTIME_STORAGE_ROOT>/snapshots/<sessionId>/<snapshotId>/`. Central records the snapshot, releases the lease, and the idle worker is scaled in (recycled).
6. Click **Resume**. Central re-queues the session, the WorkerPool scales out a **new** worker, the sidecar restores the snapshot before starting Copilot, and Copilot reattaches to its prior session. The agent can read files it created earlier and recall the conversation — on different compute.

> The first scale-out builds the sidecar image (a few minutes). Subsequent scale-outs reuse the cached image and start in seconds. Editing any file under `src/` invalidates the image's build layers, so the next scale-out rebuilds it.

## Run on Azure AI Foundry Hosted Agents (alternate WorkerPool backend)

The WorkerPool backend is chosen by config, not code: an **Azure AI Foundry hosted agent** is a peer host-pool adapter of Docker. In this mode each Worker runs **the same sidecar image** on a Foundry hosted agent instead of a local Docker container, and session commands still flow over Web PubSub exactly as in the Docker path. Foundry owns the container lifecycle (request-driven, ~15 min idle scale-to-zero); central keeps a worker warm by holding one long liveness `/invocations` request open per worker. Because a Foundry sandbox is host-managed durable storage, the Foundry session **is** our session's durable workspace: it is keyed on the session's stable `workspaceRef`, so pausing releases compute but keeps the sandbox, a resume re-invokes the same sandbox with the workspace intact, and the Foundry session is deleted only when our session ends. The full walkthrough and the confirmed Foundry data-plane contract are in [foundry/README.md](foundry/README.md).

### 1. Build and push the Foundry sidecar image

The Foundry image variant ([containers/sidecar-foundry/Dockerfile](containers/sidecar-foundry/Dockerfile)) only adds `ENV SIDECAR_HOST_CLASS=foundry` on top of the base sidecar image, which switches the outer host wrapper to serve the Foundry hosted-agent HTTP contract (`GET /readiness`, `POST /invocations`) and boot the same daemon. Build both to a registry Foundry can pull from (ACR remote build works even when a corporate proxy blocks `registry.npmjs.org` from a local `docker build`):

```powershell
az acr build -r <acr> -t agent-runtime-sidecar-poc:latest --platform linux/amd64 -f containers/sidecar/Dockerfile .
az acr build -r <acr> -t agent-runtime-sidecar-foundry:latest --platform linux/amd64 `
  --build-arg BASE_IMAGE=<acr>.azurecr.io/agent-runtime-sidecar-poc:latest `
  -f containers/sidecar-foundry/Dockerfile .
```

### 2. Deploy the image as a Foundry hosted agent (bring-your-own image)

Requires Azure Developer CLI 1.27+ with the `microsoft.foundry` extension and `az login` with access to the project. Grant the standard managed-identity roles: the Foundry **project** managed identity needs **AcrPull** on the registry (image pull), and the platform-created **agent identity** needs the model-provider role — for Azure OpenAI, **Cognitive Services OpenAI User** on the account.

```powershell
azd ai agent init --no-prompt --force `
  --project-id "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>/projects/<project>" `
  --agent-name agent-runtime-sidecar `
  --image <acr>.azurecr.io/agent-runtime-sidecar-foundry:latest `
  --protocol invocations
azd deploy --no-prompt
```

Set the in-container copilot provider config as agent environment variables (`COPILOT_MODEL`, `COPILOT_PROVIDER_TYPE`, `COPILOT_PROVIDER_BASE_URL`); provider auth is the agent's managed identity via `DefaultAzureCredential`, so no token is baked into the image.

### 3. Point central at the deployed agent and run it

The Foundry pool lives in the same default [config/](config/) profile as the Docker pools ([config/host-pool-controllers/foundry.json](config/host-pool-controllers/foundry.json), [config/worker-pools/foundry-copilot.json](config/worker-pools/foundry-copilot.json), [config/agent-specs/copilot-foundry.json](config/agent-specs/copilot-foundry.json)), so one central serves Docker and Foundry sessions side by side — a session is routed to a pool purely by its `storage` capability label (`volume-snapshot` → Docker, `host-managed` → Foundry). Edit `config/host-pool-controllers/foundry.json` so `projectEndpoint` and `agentName` match the agent you deployed, and set its `centralUrlForWorkers` to the URL the Foundry worker uses to reach central (public / tunnel URL — see the note below). Then start central normally:

```powershell
$env:WEBPUBSUB_ENDPOINT = "https://<your-web-pubsub>.webpubsub.azure.com"
pnpm start:central
```

In the web client, choose the **`copilot-foundry`** AgentSpec (it now appears alongside the Docker `copilot-poc` spec). Central scales the `foundry-copilot` pool out onto a Foundry hosted-agent worker — a cold start boots the container, which reverse-registers over Web PubSub — runs the turn, and pauses by scaling in. The Docker pools stay available in the same central for `copilot-poc` sessions.

> **Local-test topology only:** when central runs on your machine while the worker runs in Foundry, the container must reach central's `/sidecar/negotiate`. Expose central with a tunnel (for example `devtunnel host -p 3000 --allow-anonymous`) and put that public https URL in the Foundry controller's `centralUrlForWorkers` (in `config/host-pool-controllers/foundry.json`). Because that URL is resolved per host-pool-controller, the Foundry pool uses the tunnel while the Docker pools keep `host.docker.internal` — one central drives both. This is a convenience for local testing, not a production topology.

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
