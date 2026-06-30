# Issue Fixer sample

Demonstrates building an agentic app on Agent Runtime Sidecar: sign in with GitHub, pick an open issue from a repo, and a `dotnet-poc` agent session clones the repo and attempts a fix on a .NET worker. The session is durable — the worker is scaled out of the dedicated `.NET 8/9` pool, distinct from the `copilot` pool. Use the webclient dashboard to watch the dotnet WorkerPool scale out/in.

## Why a separate dotnet agent type

This sample adds an isolated agent type so the existing `copilot` / `local` types are untouched:

- AgentSpec `dotnet-poc` (labels `agent: dotnet`)
- WorkerPool `poc-docker-dotnet` (controller `docker-dotnet`)
- image `containers/sidecar-dotnet/Dockerfile` (Node + Azure CLI + git + .NET 8/9 SDK)

## GitHub sign-in (optional, device flow)

Public repos list without any login. To raise rate limits or use private repos, sign in with the GitHub **device flow** — no client secret, no callback, no token typed. Set a public client_id once (any GitHub OAuth App with device flow enabled):

```powershell
$env:ISSUE_FIXER_GITHUB_CLIENT_ID="Iv1_xxx"
```

Click sign-in, enter the shown code at github.com/login/device, approve. The browser never holds a token; the backend polls and lists issues server-side.

## Run

1. Start central (separate terminal): `pnpm start:central`
2. Install + run sample: `pnpm --dir samples/issue-fixer install; pnpm --dir samples/issue-fixer dev`
3. Open http://127.0.0.1:5174, list issues for `Azure/azure-signalr`, pick one.
