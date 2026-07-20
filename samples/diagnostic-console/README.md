# SignalOS Agentic Diagnostics

SignalOS is the end-user diagnostic application built on Agent Runtime Sidecar. A Foundry-hosted `diagnostic-expert` provides diagnostic reasoning and public web research; device evidence is collected by a `local-diagnostic` Child Session running on a manually registered standalone Worker.

The complete verified setup, startup, authorization behavior, troubleshooting steps, and browser E2E procedure are documented in [Run SignalOS Agentic Diagnostics](../../README.md#run-signalos-agentic-diagnostics).

Once Central, the Foundry pool, and the standalone local Worker are running, start the application with:

```powershell
pnpm --dir samples/diagnostic-console dev
```

Open [http://127.0.0.1:5175](http://127.0.0.1:5175).