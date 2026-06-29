# Agent Runtime Sidecar Web Client Sample

This sample is a small browser application that demonstrates the project shape: an application talks to durable agent sessions through the customer SDK, while central scales Docker WorkerPool capacity and routes work to the sidecar worker that registers from that container.

The app intentionally imports only `@agent-runtime-sidecar/sdk`. It does not import central, sidecar, storage, or shared runtime implementation code.

## What It Shows

- A ChatGPT-like session workspace backed by the SDK.
- A central-backed session list and event history loaded through the SDK.
- Multi-turn chat through `SessionHandle.send()` and `AgentTurn.events()`.
- Agent responses in the main thread.
- Agent progress/internal runtime events in the grey event rail.
- The AgentSpec requested by the sample (`copilot-poc`) and its worker selector.
- Docker WorkerPool, host instance, and worker capacity state from central diagnostics.

## Prerequisites

From the repository root:

```powershell
pnpm install
pnpm build
pnpm --dir sdk/client build
```

Authenticate to Azure for Web PubSub:

```powershell
az login
```

Docker Desktop must be running. The POC Docker WorkerPool mounts the local Azure CLI profile into sidecar containers so Azure Identity can use the same `az login` session during local development.

Set runtime environment variables for central and the Copilot SDK agent provider. The Web PubSub values below match the POC test environment in `tests/.env`.

```powershell
$env:WEBPUBSUB_ENDPOINT = "https://chenylremoteagent.webpubsub.azure.com"
$env:WEBPUBSUB_HUB = "agentruntimepoc"
$env:COPILOT_MODEL = "gpt-5.4-mini"
$env:COPILOT_PROVIDER_TYPE = "openai"
$env:COPILOT_PROVIDER_BASE_URL = "https://pmagent2.services.ai.azure.com/openai/v1"
```

The sidecar starts the GitHub Copilot SDK agent. `COPILOT_PROVIDER_*` values are passed into `CopilotClient.createSession()` as the SDK provider config; the sidecar must not call Azure OpenAI chat completions directly.

Use exactly one of these provider shapes:

- Azure AI Foundry/OpenAI-compatible v1 endpoint: `COPILOT_PROVIDER_TYPE="openai"`, `COPILOT_PROVIDER_BASE_URL="https://<resource>.services.ai.azure.com/openai/v1"`.
- Azure OpenAI resource endpoint: `COPILOT_PROVIDER_TYPE="azure"`, `COPILOT_PROVIDER_BASE_URL="https://<resource>.openai.azure.com"`, optionally `COPILOT_PROVIDER_AZURE_API_VERSION="2024-10-21"`.

For auth, run `az login` locally. In hosted environments, assign managed identity or workload identity access to the provider resource. The adapter requests `https://cognitiveservices.azure.com/.default` by default and passes the resulting bearer token to Copilot SDK. The adapter does not infer provider type from host names and does not rewrite URLs.

## Start Central

In terminal 1, from the repository root:

```powershell
$env:WEBPUBSUB_ENDPOINT = "https://chenylremoteagent.webpubsub.azure.com"
$env:WEBPUBSUB_HUB = "agentruntimepoc"
$env:TENANT_ID = "poc"
$env:CENTRAL_PORT = "3000"
pnpm start:central
```

Central listens on `http://localhost:3000` and owns session truth, event logs, worker registry, and routing.
It also owns the POC Docker WorkerPool. When the sample creates a queued session and no matching ready Worker exists, central calls the Docker hostPoolAdapter, starts a sidecar container from `containers/sidecar/Dockerfile`, and the sidecar registers through `/sidecar/negotiate` like any other Worker.

## Start The Web Client

In terminal 2, from the repository root:

```powershell
pnpm --dir samples/webclient dev
```

Open:

```text
http://127.0.0.1:5173
```

The default app settings are:

```text
Central URL: http://localhost:3000
Tenant: poc
```

Click `Connect`, start a session, then watch the WorkerPool panel move from waiting to pending/ready as central scales a Docker sidecar. The main transcript shows user/assistant messages. The event rail shows turn starts, progress events, tool events, approval events, and final turn completion as surfaced by the SDK.

## Build The Sample

```powershell
pnpm --dir samples/webclient build
```

## Notes

The sample reads session catalog and event history from central through SDK APIs. Browser state only stores connection preferences such as `centralUrl` and `tenantId`; durable session identity and history remain central-owned runtime facts.
