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
sdk/edge-worker/      # Browser edge-worker SDK: registers a web page as a Worker + local capture agent
samples/webclient/    # Browser demo that drives durable sessions through the SDK
samples/diagnostic-console/ # SignalOS end-user diagnostic application
samples/edge-worker/  # Remote Network Recovery browser edge worker demo (operator console + phone edge-worker roles)
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

The demo AgentSpecs, WorkerPools, and host-pool controllers are declarative JSON documents under `config/` (not hardcoded in `src/`). Central reads `config/agent-specs/`, `config/worker-pools/`, and `config/host-pool-controllers/` at startup. Worker types are image-declared code build profiles ([src/sidecar/worker-types.ts](src/sidecar/worker-types.ts)), not config — they only name the adapter combination the image ships. Matching is pure labels: an AgentSpec's `workerSelector.matchLabels` (including a `storage` capability label) is matched against worker labels; a worker reports its concrete `storageClass` driver at registration, and snapshots are opaque handle envelopes. Each pool sets `scalePolicy.scaleInIdleMs` and `scalePolicy.workerReportTimeoutMs`.

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

The page keeps its connection in the URL as `?central=<central-url>&tenant=<tenant-id>`. Copy the current browser URL to share a dashboard link that opens with the same Central endpoint and tenant.

Then, in the browser:

1. Set **Central URL** to `http://localhost:3000` and **Tenant** to `poc`, and click **Connect**. The right rail shows the `poc-docker-copilot` WorkerPool.
2. Click **Sessions +**, choose the `copilot-poc` AgentSpec, and click **Create Session**.
3. Central queues the session and the WorkerPool scales out a Docker worker: it runs a container from the pre-built sidecar image ([containers/sidecar/Dockerfile](containers/sidecar/Dockerfile), built via `pnpm build:sidecar-image`), the sidecar registers through `/sidecar/negotiate`, central assigns the session, and the Copilot agent starts. The session moves `queued → starting → running`.
4. Chat with the agent in the composer. Streamed output appears in the thread and runtime events appear in the grey rail.
5. Click **Pause**. The sidecar reaches a turn boundary, flushes the Copilot session files, and the workspace plus agent state are captured to a session-addressed snapshot under `<RUNTIME_STORAGE_ROOT>/snapshots/<sessionId>/<snapshotId>/`. Central records the snapshot, releases the lease, and the idle worker is scaled in (recycled).
6. Click **Resume**. Central re-queues the session, the WorkerPool scales out a **new** worker, the sidecar restores the snapshot before starting Copilot, and Copilot reattaches to its prior session. The agent can read files it created earlier and recall the conversation — on different compute.

> WorkerPool scale-out never builds an image. Re-run `pnpm build:sidecar-image` after changing runtime code; subsequent scale-outs use that pre-built local image.

## Run on Azure AI Foundry Hosted Agents (alternate WorkerPool backend)

The WorkerPool backend is chosen by config, not code: an **Azure AI Foundry hosted agent** is a peer host-pool adapter of Docker. In this mode each Worker runs the same sidecar image on Foundry, while commands still flow over Web PubSub. Foundry owns the request-driven container lifecycle; central holds a long `/invocations` request as host control. The stable `workspaceRef` identifies the durable Foundry sandbox. A HostPoolInstance is one durable host-control attempt, while its current Worker is one heartbeat-proven sidecar process lifetime. After central restart, a new controller epoch reopens the persisted host handle and waits for a fresh Worker report; stale `ready` is never trusted as current fact. The full walkthrough is in [foundry/README.md](foundry/README.md).

### 1. Build and push the Foundry sidecar image

The Foundry image variant ([containers/sidecar-foundry/Dockerfile](containers/sidecar-foundry/Dockerfile)) selects the Foundry host wrapper, runs with the user required for the persistent `$HOME` mount, and requires deployment-stable non-secret Copilot provider build args. Build it with an immutable tag in a registry Foundry can pull from:

```powershell
az acr build -r <acr> -t agent-runtime-sidecar-poc:<tag> --platform linux/amd64 -f containers/sidecar/Dockerfile .
az acr build -r <acr> -t agent-runtime-sidecar-foundry:<tag> --platform linux/amd64 `
  --build-arg BASE_IMAGE=<acr>.azurecr.io/agent-runtime-sidecar-poc:<tag> `
  --build-arg COPILOT_MODEL=<model-name> `
  --build-arg COPILOT_PROVIDER_TYPE=openai `
  --build-arg COPILOT_PROVIDER_BASE_URL=https://<account>.services.ai.azure.com/openai/v1 `
  -f containers/sidecar-foundry/Dockerfile .
```

### 2. Deploy the image as a Foundry hosted agent (bring-your-own image)

Requires Azure Developer CLI 1.27+ with the `microsoft.foundry` extension and `az login` with access to the project. Grant the standard managed-identity roles: the Foundry **project** managed identity needs **AcrPull** on the registry (image pull), and the platform-created **agent identity** needs the model-provider role — for Azure OpenAI, **Cognitive Services OpenAI User** on the account.

```powershell
azd ai agent init --no-prompt --force `
  --project-id "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>/projects/<project>" `
  --agent-name agent-runtime-sidecar `
  --image <acr>.azurecr.io/agent-runtime-sidecar-foundry:<tag> `
  --protocol invocations
```

Before deploy, verify generated `azure.yaml` and `agent.yaml` both say `protocol: invocations`; current azd beta can write `responses` despite the flag. Correct those generated entries, then run `azd deploy --no-prompt`. Provider values are non-secret build args; provider authentication remains the agent managed identity. Use immutable tags, not `latest`.

### 3. Point central at the deployed agent and run it

The Foundry pool lives in the same default [config/](config/) profile as the Docker pools ([config/host-pool-controllers/foundry.json](config/host-pool-controllers/foundry.json), [config/worker-pools/foundry-copilot.json](config/worker-pools/foundry-copilot.json), [config/agent-specs/copilot-foundry.json](config/agent-specs/copilot-foundry.json)), so one central serves Docker and Foundry sessions side by side — a session is routed to a pool purely by its `storage` capability label (`volume-snapshot` → Docker, `host-managed` → Foundry). Edit `config/host-pool-controllers/foundry.json` so `projectEndpoint` and `agentName` match the agent you deployed, and set its `centralUrlForWorkers` to the URL the Foundry worker uses to reach central (public / tunnel URL — see the note below). Then start central normally:

```powershell
$env:WEBPUBSUB_ENDPOINT = "https://<your-web-pubsub>.webpubsub.azure.com"
pnpm start:central
```

In the web client, choose the **`copilot-foundry`** AgentSpec (it now appears alongside the Docker `copilot-poc` spec). Central scales the `foundry-copilot` pool out onto a Foundry hosted-agent worker — a cold start boots the container, which reverse-registers over Web PubSub — runs the turn, and pauses by scaling in. The Docker pools stay available in the same central for `copilot-poc` sessions.

> **Local-test topology only:** when central runs on your machine while the worker runs in Foundry, the container must reach central's `/sidecar/negotiate`. Expose central with a tunnel (for example `devtunnel host -p 3000 --allow-anonymous`) and put that public https URL in the Foundry controller's `centralUrlForWorkers` (in `config/host-pool-controllers/foundry.json`). Because that URL is resolved per host-pool-controller, the Foundry pool uses the tunnel while the Docker pools keep `host.docker.internal` — one central drives both. This is a convenience for local testing, not a production topology.

## Run SignalOS Agentic Diagnostics

[samples/diagnostic-console/](samples/diagnostic-console/) is an end-user application built on the runtime. SignalOS starts a `diagnostic-expert` Session on the existing Foundry WorkerPool. The expert can answer from its diagnostic knowledge and fetch public documentation, but it cannot treat its Foundry container as the user's machine. When it needs device facts, it calls `inspect_local_system`; Central routes that Delegate to a `local-diagnostic` Child Session on a manually registered standalone Worker on the developer machine.

The existing [samples/webclient/](samples/webclient/) is only an optional runtime dashboard for observing Sessions, Workers, WorkerPools, events, and interactions. End users use SignalOS on port `5175`; they do not need the dashboard.

### 1. Prepare the repository and Azure login

From the repository root:

```powershell
pnpm install
pnpm build
pnpm --dir sdk/client build
pnpm --dir samples/diagnostic-console build
az login
```

The current sample expects the existing Foundry hosted agent declared by [config/host-pool-controllers/foundry.json](config/host-pool-controllers/foundry.json):

```text
Project: https://pmagent2.services.ai.azure.com/api/projects/proj-default
Agent:   agent-runtime-sidecar
```

If that hosted agent has not been deployed, complete the image build and deployment in [foundry/README.md](foundry/README.md) first. The deployed image must use the `invocations` protocol and must contain the provider build arguments described there.

### 2. Expose Central to the Foundry worker

Central runs locally on port `3000`, but the Foundry container must call its `/sidecar/negotiate` endpoint. Start a tunnel in a dedicated terminal:

```powershell
devtunnel host -p 3000 --allow-anonymous
```

Copy the tunnel's public HTTPS URL into `centralUrlForWorkers` in [config/host-pool-controllers/foundry.json](config/host-pool-controllers/foundry.json). The currently configured URL is:

```text
https://8p3g7wcl-3000.aue.devtunnels.ms
```

Keep the tunnel process running. If `devtunnel` returns a different URL, update the config before starting Central. Central loads AgentSpecs, Delegates, WorkerPools, and host-pool-controller config only at startup.

### 3. Start Central

In a second terminal:

```powershell
$env:WEBPUBSUB_ENDPOINT = "https://chenylremoteagent.webpubsub.azure.com"
$env:WEBPUBSUB_HUB = "agentruntimepoc"
$env:CENTRAL_PORT = "3000"
pnpm start:central
```

Expected startup output includes:

```text
central service listening on http://localhost:3000
worker pool foundry-copilot will connect sidecars to https://8p3g7wcl-3000.aue.devtunnels.ms
```

Restart Central after changing either diagnostic AgentSpec or the Delegate config:

- [config/agent-specs/diagnostic-expert.json](config/agent-specs/diagnostic-expert.json)
- [config/agent-specs/local-diagnostic.json](config/agent-specs/local-diagnostic.json)
- [config/delegates/local-diagnostic.json](config/delegates/local-diagnostic.json)

### 4. Register the standalone local diagnostic Worker

The local machine is intentionally represented by one standalone Worker, not by a WorkerPool. Start it in a third terminal on the machine SignalOS should diagnose:

```powershell
$env:CENTRAL_URL = "http://localhost:3000"
$env:TENANT_ID = "poc"
$env:WORKER_TYPE = "copilot-local"
$env:SIDECAR_LABELS_JSON = '{"agent":"local-diagnostic","storage":"host-managed"}'
$env:SIDECAR_CAPACITY = "10"

$env:COPILOT_MODEL = "gpt-5.4-mini"
$env:COPILOT_PROVIDER_TYPE = "openai"
$env:COPILOT_PROVIDER_BASE_URL = "https://pmagent2.services.ai.azure.com/openai/v1"

pnpm start:sidecar
```

Expected output:

```text
sidecar daemon started as worker type copilot-local via host env
```

Do not set `WORKER_POOL_ID` for this process. Its labels match only the `local-diagnostic` AgentSpec, and Central cannot scale out or replace the developer machine. Capacity is `10`, so this standalone Worker can host up to ten concurrent `local-diagnostic` Sessions.

If the sidecar reports `Session was not created with authentication info or custom provider`, the three `COPILOT_*` provider variables are missing from that terminal. If a long-lived local agent session later receives provider HTTP `401`, restart the standalone sidecar so `DefaultAzureCredential` obtains a fresh bearer token.

### 5. Start SignalOS

In a fourth terminal:

```powershell
pnpm --dir samples/diagnostic-console dev
```

Open [http://127.0.0.1:5175](http://127.0.0.1:5175). The default connection is `http://localhost:3000`, tenant `poc`; use the settings button to change either value. SignalOS keeps both values in the URL as `?central=<central-url>&tenant=<tenant-id>`, so copying the current browser URL preserves the connection for another user.

SignalOS keeps one Session in page memory:

- The first question or quick diagnostic creates a `diagnostic-expert` Session.
- Later questions reuse that Session while the page remains open.
- **New** becomes available after the current turn finishes. It pauses the previous Session and resets the page to a new case.
- Refreshing the page starts with an empty browser case; the runtime Session remains visible in the optional dashboard, but SignalOS intentionally does not persist or restore its ID.

### 6. Exercise the two diagnostic paths

For a device-backed diagnosis, click **Why is my machine slow?**. The expected flow is:

1. SignalOS starts the Foundry `diagnostic-expert` Session.
2. The expert calls `inspect_local_system`.
3. Central creates or resumes a `local-diagnostic` Child Session and assigns it to the standalone Worker.
4. SignalOS displays one end-user consent dialog for read-only device checks.
5. Click **Allow this diagnosis** once. For the rest of that browser case, SignalOS automatically approves each later approval originating from `local-diagnostic`.
6. The device card progresses through **Understand**, **Permission**, **Check**, and **Results**.
7. The Foundry expert returns a conclusion that separates observed device facts, likely causes, and one next step.

For a knowledge-only question, click an item under **Ask an expert**, or ask the expert to consult public documentation. Public URL fetch permissions are approved automatically and do not show the device consent dialog. SignalOS rejects hosted shell or filesystem approvals: the Foundry workspace is not the target machine, and target-machine evidence must go through `inspect_local_system`.

### 7. Optional runtime observation

To inspect the platform while using SignalOS, start the dashboard separately:

```powershell
pnpm --dir samples/webclient dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), connect to `http://localhost:3000`, and select tenant `poc`. A device diagnosis should show:

- one `diagnostic-expert` Parent Session on `foundry-copilot`;
- one `local-diagnostic` Child Session beneath it;
- one standalone Worker with labels `agent=local-diagnostic, storage=host-managed`;
- approval interactions projected from the Child to the Parent.

The dashboard is an operator view and is not part of the SignalOS end-user workflow.

### 8. Validate the sample build

```powershell
pnpm --dir samples/diagnostic-console build
pnpm typecheck
pnpm test
```

The verified browser E2E covers both paths: one device diagnosis completed after a single visible consent, and one public Microsoft documentation fetch completed without an approval dialog or local device inspection.

## Run the Remote Network Recovery Browser Edge Worker

[samples/edge-worker/](samples/edge-worker/) turns a **phone browser into a temporary Worker** for a durable cloud recovery session, using the runtime's existing **Delegation** model. The scenario is a home-network fault: the user's internet is down and they reach a durable **Network Recovery Console** agent from a phone, often over a weak cellular link. The cloud agent (`network-recovery-expert`) holds the recovery ticket — the reported symptom, any carrier line-status notes, what has been tried, the next step. When it needs to see the real hardware (router / fiber modem / ONT), it calls the Central-defined delegate tool `scan_device_evidence`. Central resolves that delegate to the `device-scan-probe` callee, creates a **child session**, and — purely by capability labels — routes it to the phone's **Device Scan** tab. The browser edge worker asks the person to explicitly frame and capture one frame, analyses it **locally**, and returns **only structured optical observations** (brightness, exposure, glare, focus, dominant colour, detected indicator lights, decoded QR/barcode) plus a short summary. The raw frame never leaves the device.

The browser worker reuses the same runtime protocol as the Node sidecar — the tab reverse-registers over `/sidecar/negotiate`, joins Web PubSub, heartbeats, and answers `session.assign` / `session.input` / `session.pause.requested` — via a dedicated [sdk/edge-worker/](sdk/edge-worker/) package. The end-to-end delegation chain is proven against a real `CentralService` in [tests/edge/delegation-network-recovery.integration.test.ts](tests/edge/delegation-network-recovery.integration.test.ts) (part of `pnpm test`).

The one app serves two roles from `?role=`:

- **Network Recovery Console** (`?role=console`) — the client SDK (`@agent-runtime-sidecar/sdk`) creates/resumes a `network-recovery-expert` parent session, sends it plain-language instructions, then discovers and observes the delegated child session (the child inherits the parent's owner). It renders the agent's diagnosis log, the routed scan steps, the structured evidence timeline, the connected device manifest, and a rolled-up diagnosis.
- **Device Scan** (`?role=edge`) — the edge SDK (`@agent-runtime-sidecar/edge-worker`) registers the tab as a Worker, shows its capability manifest, and — only after an explicit user gesture — opens the camera, captures a frame, analyses it locally, and returns the structured observation. Results are queued in `localStorage` when the connection drops and replayed on reconnect.

### 1. Build the SDKs and start Central

The browser worker is a normal Worker, so it needs a running Central with Web PubSub (browsers speak Web PubSub, not the in-memory transport):

```powershell
pnpm install
pnpm build
pnpm --dir sdk/client build
pnpm --dir sdk/edge-worker build
az login
$env:WEBPUBSUB_ENDPOINT = 'https://<your-wps>.webpubsub.azure.com'
$env:WEBPUBSUB_HUB = 'agentruntimepoc'
pnpm start:central
```

`network-recovery-expert`, `device-scan-probe`, and the `device-scan-capture` delegate are declarative documents in [config/](config/). The parent matches the existing `poc-docker-copilot` pool through `{ agent: copilot, storage: volume-snapshot }`. The browser callee's base selector is `{ agent: browser-edge, storage: host-managed }`, but a tab becomes eligible for a case only after it redeems that case's one-time invite and Central mints its authoritative `{ case, deviceRef }` binding labels.

### 2. Provide the parent "brain" (a real Copilot worker)

The parent `network-recovery-expert` session needs a worker to run its turns and fire the delegate tool. The default local path is the existing **`poc-docker-copilot` WorkerPool**: Central creates one no-reuse, session-pinned Docker worker for each queued console case. The worker runs the real `CopilotProcessAdapter`, decides when to call `scan_device_evidence`, and interprets the returned structured evidence.

**A. Local Docker WorkerPool — default.** Build the sidecar image once before starting Central:

```powershell
az login
pnpm build:sidecar-image
$env:WEBPUBSUB_ENDPOINT = 'https://<your-wps>.webpubsub.azure.com'
$env:WEBPUBSUB_HUB = 'agentruntimepoc'
$env:COPILOT_MODEL = '<your-model-deployment>'
$env:COPILOT_PROVIDER_TYPE = 'azure' # or openai
$env:COPILOT_PROVIDER_BASE_URL = 'https://<your-provider-endpoint>'
pnpm start:central
```

Central forwards the non-secret provider configuration, mounts the host Azure CLI profile into the container for `DefaultAzureCredential`, and scales the pre-built image when a case queues. The current Docker adapter uses a writable bind mount because Azure CLI token state may refresh; treat that profile as credential-bearing host state and use a dedicated test identity/profile where possible. A second console queues a second session-pinned instance instead of requiring another manually launched parent.

**B. Standalone real Copilot worker — optional debugging path.** A `copilot-process-wrapper` sidecar with labels `{"agent":"copilot","storage":"volume-snapshot"}` can satisfy the same AgentSpec without Docker. This is useful for adapter debugging, but it has fixed manual capacity; use the Docker pool to validate automatic multi-console scale-out.

**C. Scripted offline harness — deterministic tests only.** It registers a real `SidecarDaemon`, but its adapter emits a fixed delegate call and does not reason. Never use it as proof of a real Copilot parent.

```powershell
$env:CENTRAL_URL = 'http://localhost:3000'
$env:TENANT_ID = 'poc'
pnpm --dir samples/edge-worker dev:offline-parent
```

### 3. Run the sample

```powershell
pnpm --dir samples/edge-worker dev   # http://127.0.0.1:5176
```

### 4. Two-device (or two-tab) demo

1. Open the **console**: `http://127.0.0.1:5176/?role=console&central=http://localhost:3000&tenant=poc`, then press **Start recovery session**. Instructions remain disabled while the parent is queued and become available only after the Docker worker registers and the case is `running`.
2. Press **Create pairing invite**. Open the generated one-time link in a second browser tab. The invite secret is in the `#pair` fragment, is stripped after redemption, and must never be copied into source control or logs.
3. On **Device Scan**, press **Enroll & join**. The camera remains off; the console roster shows the device before any capture. Mint every additional device invite from this same console/case.
4. Choose one `deviceRef` or **All paired devices**, then send an instruction such as **Check indicator lights**. The real parent decides to call `scan_device_evidence`; Central enforces the operator-selected per-turn target.
5. On each targeted edge tab press **Use sample frame** for a fully local two-tab test, or explicitly open the camera from a secure origin. Only structured observations return to the parent.

### 5. Validate

```powershell
pnpm --dir sdk/edge-worker typecheck
pnpm --dir sdk/edge-worker test          # analyzer, camera-agent, weak-network runtime unit tests
pnpm --dir sdk/edge-worker test:package  # CommonJS require + native Node ESM import
pnpm --dir samples/edge-worker test      # console/Device Scan UI helper unit tests
pnpm --dir samples/edge-worker build     # tsc + vite build
```

### Honest browser limitations

- **Not a daemon.** The worker *is* the browser tab. Closing it, or backgrounding it long enough for the runtime's orphan/idle timeout, suspends the worker; the durable session survives and can be re-served when a worker reconnects.
- **Weak-network by design.** Structured JSON is the default (and only) payload; the raw frame stays on the device. If the connection drops mid-capture, the result is saved in a `localStorage` queue and replayed to the same session on reconnect — the edge UI shows connected / queued / synced state.
- **Camera needs a secure context.** `getUserMedia` only works on `https://` or `localhost`. A phone opening the sample over plain LAN `http://` cannot open the live camera. Use a temporary HTTPS reverse proxy without committing its generated public URL, or use the built-in **sample-frame** fallback.
- **Consent is local and per-capture.** A routed task never auto-opens the camera. The task only produces a card; the frame is captured only after an explicit tap, and can be declined.
- **Local probe, not a browser VLM.** The default analyzer computes real optical signals (brightness, exposure, contrast, colour temperature, Laplacian-variance focus, glare) plus LED-blob detection, and uses the native `BarcodeDetector` for QR/codes when present — with an honest degradation notice when it is not. Device-model semantics and the final diagnosis are the cloud agent's job. `FrameAnalyzer` is the seam where a future WebGPU/ONNX/WebNN model can be dropped in without changing the worker or console.



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
