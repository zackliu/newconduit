# Foundry Hosted-Agent WorkerPool (deploy)

This directory holds the deploy-time steps for running Agent Runtime Sidecar **workers on Azure AI Foundry
hosted agents** (Approach A). The runtime config central loads lives in the shared [../config/](../config)
profile alongside the Docker pools (a `foundry-copilot` pool coexists with the Docker pools, routed by the
`storage` capability label); this directory keeps only the deploy guide.

Design source of truth: [specs/foundry-hosted-agent-workerpool-ch.md](../specs/foundry-hosted-agent-workerpool-ch.md).
The confirmed Foundry data-plane API is documented in that spec's appendix (§15).

## What this is

A Foundry hosted agent is another **host-pool adapter** — a peer of the Docker adapter, selected by config, not
by any `if (foundry)` branch. The Foundry container runs **our sidecar image** (same image, same
Worker/lease/event model as Docker); only the outer host wrapper and the lifecycle owner differ:

- **Container = our sidecar image**, started with `SIDECAR_HOST_CLASS=foundry`. That host adapter serves the
  Foundry hosted-agent HTTP contract (`GET /readiness`, `POST /invocations`) and boots the sidecar daemon.
- **Commands stay on Web PubSub.** The daemon negotiates its Web PubSub connection from central and receives
  assign/turn/pause exactly as in the Docker path. The HTTP `/invocations` surface only carries boot + keepalive.
- **Foundry owns the container lifecycle** (request-driven, ~15 min idle scale-to-zero). Central keeps a worker
  warm by holding **one long liveness `/invocations` request open per worker** (validated to hold ≥20 min > the
  15 min idle reap). On pause, scale-in aborts that request and **stops the Foundry session** (`POST /stop`, which
  moves it to `idle`) to release compute while keeping the sandbox; the session is deleted only when our session ends.
- **Workspace persistence: host-managed storage lives under `$HOME`, and the Foundry variant runs as `root`.**
  Foundry persists **only `$HOME`** across idle scale-to-zero / container recycle (the image's `/runtime` and every
  other writable location are ephemeral), so the Foundry sidecar host adapter roots the Copilot workspace + session
  state under the container's runtime `$HOME` (`os.homedir()`). Two facts a local `docker run` can't show: Foundry
  sets `$HOME` to its per-session persistent mount **`/home/session`** (not the image's `/home/sidecar`), and it runs
  the image as the declared USER — `/home/session` is root-owned, so the base image's `USER sidecar` hits `EACCES`
  (session hangs in `starting`). [containers/sidecar-foundry/Dockerfile](../containers/sidecar-foundry/Dockerfile)
  therefore adds `USER root` (the Docker base image keeps `USER sidecar`). Result: files the agent writes survive
  pause → idle-reap → resume onto a fresh container.

```mermaid
flowchart LR
  subgraph central [central (config/ profile)]
    FA[FoundryHostPoolAdapter]
  end
  subgraph foundry [Foundry hosted agent = our sidecar image]
    HOST[foundry sidecar host adapter\n/readiness + /invocations]
    DAEMON[SidecarDaemon]
  end
  FA -- POST /invocations (boot + held liveness) --> HOST
  HOST -- boot once --> DAEMON
  DAEMON <-- Web PubSub commands --> central
  FA -- scaleIn: abort+stop (retain) / DELETE (release) --> foundry
```

## How scale-out / scale-in map to Foundry

- Foundry pools are **no-reuse**, so central scales one **session-pinned** instance per queued session (carrying the
  session's stable `workspaceRef`). Because a Foundry sandbox is host-managed durable storage, the Foundry session
  **is** that session's durable workspace.
- `scaleOut` uses `agent_session_id = the instance's workspaceRef`. It first `POST /stop`s that session to
  normalize any prior state (not-exist / `idle` / stale-`active`) to "no live compute", then opens a held
  `POST /invocations` with the boot payload and returns `{ containerId: sessionId }`. Normalizing first guarantees
  the invocation cold-boots a **fresh** container whose boot-once sidecar registers under this instance id (a still-
  warm container would keep its old sidecar under the previous instance id and the new instance would never
  correlate). Holding the request suppresses the idle reap; the loop reconnects with the same session id if the
  stream drops. (An unpinned/shared instance falls back to a per-instance `w-<instanceId>` id.)
- `scaleIn` aborts the held request, then honors a `durableAction`: `retain` (the bound session is still alive,
  e.g. paused) **stops** the Foundry session (`POST /stop` → `idle`) so compute is released while the sandbox +
  `$HOME` survive - a resume (a fresh instance carrying the same `workspaceRef`) re-invokes the stopped session
  into a fresh container generation with the workspace intact; `release` (the bound session ended) `DELETE`s it
  (`→ deleted`). Aborting alone is not enough: the container would stay warm ~15 min and a resume would re-invoke
  the orphaned sidecar; the explicit stop is what leaves the session cleanly reusable.

## Prerequisites

- Azure Developer CLI **1.27+** and the **`microsoft.foundry`** azd extension.
- A Foundry project (account + project) and `az login` with access to it.
- A container registry Foundry can pull from (for the bring-your-own image).
- Central's own prerequisites: `WEBPUBSUB_ENDPOINT` and `az login` (central mints the Foundry data-plane token
  via `DefaultAzureCredential`, audience `https://ai.azure.com/.default`).

## Deploy

### 1. Build and push the Foundry sidecar image

Two ways to build. **ACR remote build is recommended** — it builds inside Azure (clean network), so it works
even when a corporate proxy blocks `registry.npmjs.org` from a local `docker build`.

**Remote build (recommended):**

```powershell
# base image
az acr build -r <acr> -t agent-runtime-sidecar-poc:latest --platform linux/amd64 -f containers/sidecar/Dockerfile .
# Foundry variant (FROM the base + ENV SIDECAR_HOST_CLASS=foundry)
az acr build -r <acr> -t agent-runtime-sidecar-foundry:latest --platform linux/amd64 `
  --build-arg BASE_IMAGE=<acr>.azurecr.io/agent-runtime-sidecar-poc:latest `
  -f containers/sidecar-foundry/Dockerfile .
```

If a corporate proxy corrupts large context uploads (`az acr build` fails with `failed to download context`),
build from a **minimal context** containing only what the base Dockerfile COPYs (`package.json`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `src/`, `config/`, and the three `package.json`
files) — the smaller upload gets through. On Windows, set `$env:PYTHONUTF8='1'` to avoid an az CLI
log-streaming encoding crash (the remote build still completes; check `az acr task list-runs -r <acr>`).

**Local build (needs `registry.npmjs.org` reachable from the Docker build):**

```powershell
pnpm build:sidecar-image   # -> agent-runtime-sidecar-poc:latest (base image)
docker build -f containers/sidecar-foundry/Dockerfile -t <acr>.azurecr.io/agent-runtime-sidecar-foundry:v1 .
az acr login --name <acr>
docker push <acr>.azurecr.io/agent-runtime-sidecar-foundry:v1
```

The variant only adds `ENV SIDECAR_HOST_CLASS=foundry` on top of the base image, via the `BASE_IMAGE` build arg
(which defaults to the local `agent-runtime-sidecar-poc:latest` tag).

### 2. Deploy the image as a Foundry hosted agent (bring-your-own image)

```powershell
azd ai agent init --no-prompt --force `
  --project-id "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<account>/projects/<project>" `
  --agent-name agent-runtime-sidecar `
  --image <acr>.azurecr.io/agent-runtime-sidecar-foundry:v1 `
  --protocol invocations
azd deploy --no-prompt
```

`--image` takes the pre-built image (no template/Dockerfile/ACR scaffolding), and `--protocol invocations`
declares the hosted-agent protocol our host adapter serves. Reusing `--agent-name` deploys a **new version** of
the same agent.

**Managed-identity RBAC.** Foundry pulls the image with the **project** managed identity (the project resource's
system-assigned identity, not the account's) — grant it **AcrPull** on the registry, or the deploy fails while
polling with `[ImageError] Container registry authentication failed`. The in-container copilot process runs as
the platform-created **agent identity** (`azd ai agent show` lists its instance and blueprint principal ids); for
Azure OpenAI it needs **Cognitive Services OpenAI User** on the account. Both are standard role assignments via
`az role assignment create`; do not fall back to registry admin keys or tokens.

### 3. Agent runtime configuration

The image already selects the Foundry host (`SIDECAR_HOST_CLASS=foundry`) and listens on `PORT` (default 8088;
set it to whatever the platform assigns). The in-container copilot process still needs its model-provider
configuration — set the same non-secret provider env used elsewhere on the agent (`COPILOT_MODEL`,
`COPILOT_PROVIDER_TYPE`, `COPILOT_PROVIDER_BASE_URL`; provider auth is Azure Identity/MSI), and provision any
GitHub credential as a Foundry project connection rather than a plaintext env value.

### 4. Point central at the deployed agent

Edit [../config/host-pool-controllers/foundry.json](../config/host-pool-controllers/foundry.json) so
`projectEndpoint` and `agentName` match the agent you just deployed, and set `centralUrlForWorkers` to the URL
the Foundry worker uses to reach central (public / tunnel URL — see step 5):

```json
{
  "id": "foundry",
  "adapterKind": "foundry",
  "projectEndpoint": "https://<account>.services.ai.azure.com/api/projects/<project>",
  "agentName": "agent-runtime-sidecar",
  "workerType": "copilot-local",
  "centralUrlForWorkers": "https://<your-public-or-devtunnel-central-url>"
}
```

`workerType: copilot-local` selects the local-workspace build profile (storage class `host-managed`), which is
the right fit for a Foundry sandbox (no Docker volumes). It matches the `storage: host-managed` label on the
`foundry-copilot` pool and the `copilot-foundry` AgentSpec selector.

### 5. Run central

The Foundry pool is part of the default `config/` profile, so central picks it up with no extra `CONFIG_DIR`:

```powershell
$env:WEBPUBSUB_ENDPOINT = "https://<your-webpubsub>.webpubsub.azure.com"
pnpm start:central
```

Creating a `copilot-foundry` session now scales the `foundry-copilot` pool out onto a Foundry hosted-agent
worker, and pausing it scales in (aborts the liveness request and **stops** the Foundry session to `idle`, keeping
the sandbox so a resume re-invokes it); ending the session deletes it. Docker `copilot-poc` sessions keep working
in the same central — the two pools coexist and are matched by the `storage` label.

Central mints the Foundry data-plane token from `DefaultAzureCredential`, so run it where `az login` (or a
managed identity) can reach the project. When central runs locally, the Foundry worker still has to reach
central's `/sidecar/negotiate` to register — expose central with a tunnel and set the Foundry controller's
`centralUrlForWorkers` to that public URL, for example `devtunnel host -p 3000 --allow-anonymous` plus
`"centralUrlForWorkers": "https://<id>-3000.<region>.devtunnels.ms"` in
[../config/host-pool-controllers/foundry.json](../config/host-pool-controllers/foundry.json). That URL resolves
per host-pool-controller, so only Foundry workers use the tunnel — the Docker pools keep `host.docker.internal`.
The public tunnel is a local-test convenience only, not a production topology.

## Files

| Path | Purpose |
| --- | --- |
| [../config/agent-specs/copilot-foundry.json](../config/agent-specs/copilot-foundry.json) | Copilot AgentSpec selecting `storage: host-managed` |
| [../config/worker-pools/foundry-copilot.json](../config/worker-pools/foundry-copilot.json) | Pool bound to the `foundry` host-pool controller |
| [../config/host-pool-controllers/foundry.json](../config/host-pool-controllers/foundry.json) | Foundry adapter wiring (edit `projectEndpoint` + `agentName` + `centralUrlForWorkers`) |
| [../containers/sidecar-foundry/Dockerfile](../containers/sidecar-foundry/Dockerfile) | Sidecar image variant that selects the `foundry` host adapter |

## Gated end-to-end test

`tests/workerpool/foundry-workerpool.integration.test.ts` is skipped unless `RUN_FOUNDRY_WORKERPOOL_E2E=1` and
`FOUNDRY_PROJECT_ENDPOINT` + `FOUNDRY_AGENT_NAME` are set (read from `tests/.env`), with `az login`. It drives the
real data plane through the adapter's `scaleOut`/`scaleIn` over the full boot → pause → resume → release cycle:
boot leaves the session `active`, `retain` scale-in stops it to `idle` (reusable, not deleted), a fresh instance
re-invokes the same `workspaceRef` back to `active`, and `release` scale-in deletes it.
