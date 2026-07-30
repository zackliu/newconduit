# Remote Network Recovery · Browser Edge Worker

A two-role demo that turns a **phone browser into a temporary Worker** for a durable cloud recovery session, built on the Agent Runtime Sidecar runtime and its existing **Delegation** model. Nothing here is mocked — it reuses the real runtime protocol, the customer client SDK, and the browser edge SDK.

The scenario is a home-network fault. The user's internet is down and they reach a durable **Network Recovery Console** agent from a phone, often over a weak cellular link. The cloud agent (`network-recovery-expert`) holds the recovery ticket context: the reported symptom, any carrier line-status notes, what has been tried, and the next step. When it needs to see the real hardware (a home router, fiber modem/ONT, or access point), it calls the Central-defined delegate tool `scan_device_evidence` with a **target** — one paired device or every device on the case. Central resolves the target against the case's authoritative device roster, creates one **child session** per targeted device, and routes each to the bound phone's **Device Scan** tab. The phone asks the user to explicitly frame and capture one frame, analyses it **locally**, and returns **only structured optical observations**. The raw frame never leaves the device.

- The **Network Recovery Console** role drives the parent session with the client SDK (`@agent-runtime-sidecar/sdk`), mints one-time pairing invites, lists the case's paired devices, and observes the delegated child sessions.
- The **Device Scan** role registers the browser tab as a real Worker with the edge SDK (`@agent-runtime-sidecar/edge-worker`), over the same `/sidecar/negotiate` + Web PubSub protocol the Node sidecar uses.

## Roles

One Vite app, selected by the `?role=` query parameter:

| Role | URL | What it does |
| --- | --- | --- |
| Network Recovery Console | `?role=console` | Start/resume a `network-recovery-expert` parent session (the recovery **case**), mint one-time pairing invites, and list the case's paired devices from the Central roster. Send the agent plain-language instructions, pick a **scan target** (one device or all), then discover and observe the delegated child sessions. Renders the agent's diagnosis log, per-device scan assignment/stages, a structured evidence timeline, and a rolled-up diagnosis. |
| Device Scan | `?role=edge` | Self-mint a stable opaque `deviceId`, redeem the one-time invite into a durable Central binding, then register the tab as a Worker. Show the capability manifest, and — only after an explicit tap — open the camera, capture a frame, analyse it locally, and return structured observations. Results are queued in `localStorage` when offline and replayed on reconnect. |

## Run

The browser worker is a normal Worker, so it needs a running Central **with Web PubSub** (browsers speak Web PubSub, not the in-memory test transport).

```powershell
# from the repo root
pnpm install
pnpm build
pnpm --dir sdk/client build
pnpm --dir sdk/edge-worker build

az login
$env:WEBPUBSUB_ENDPOINT = 'https://<your-wps>.webpubsub.azure.com'
$env:WEBPUBSUB_HUB = 'agentruntimepoc'
pnpm start:central          # CORS-open HTTP on :3000

pnpm --dir samples/edge-worker dev   # http://127.0.0.1:5176
```

`network-recovery-expert`, `device-scan-probe`, and the `device-scan-capture` delegate are declarative documents under `config/`. The parent matches the existing `poc-docker-copilot` pool through `agent: copilot` + `storage: volume-snapshot`; the browser callee's base selector matches `agent: browser-edge` + `storage: host-managed`. A device is routed to only after it has **redeemed a pairing invite** and Central has minted its `{ case, deviceRef }` binding labels — a joined-but-unbound tab is never eligible for a case's scans.

### Identity, pairing & routing (Central-authoritative)

Device identity and authorization are separate, and neither travels in a query parameter or log:

- **`deviceId`** — the Device Scan tab mints a cryptographically random opaque id on first visit and stores it locally (no fingerprint, UA, or hardware serial). It is **identity metadata, not authorization**: the device reports it on every register/reconnect, but it never grants routing on its own.
- **One-time invite** — the console calls `client.cases.createPairingInvite(caseId)` (the case is the parent session). The pair link carries the invite **only in the URL fragment** (`#pair=<inviteId>.<inviteSecret>`); the Device Scan page reads it, strips it with `history.replaceState`, and redeems it exactly once.
- **Binding credential** — redeeming (`redeemPairingInvite`, an explicit user action over HTTP POST) returns a durable `{ caseId, deviceRef, bindingCredential }`. The credential is a high-entropy bearer token **revealed exactly once**; Central persists only a salted (and optionally peppered) HMAC verifier, never the plaintext. The device presents that binding — never the invite — on register and every reconnect. Central validates the credential and **mints** the `{ case, deviceRef }` worker labels itself, rejecting any client-sent case/deviceRef. Mint a fresh invite per additional device.
- **Revocation** — an operator can remove a device (`revokeDevice`), and closing the case revokes every binding (`revokeCase`), after which the stored credential no longer authorizes a register/reconnect and the device drops off the roster. A fresh operator-authorized invite re-admits a revoked device under the same `deviceRef`. v1 authorizes with this bearer credential only; there is deliberately **no device key** stored, because an unused key would imply a signed challenge-response we have not built. The `BindingCredentialProvider` interface is the single swap point for adding asymmetric proof later.
- **Roster & targeting** — the console reads the case's authorized devices with `client.cases.listDevices(caseId)` (`CaseDeviceView[]`: `deviceRef`, `deviceLabel`, `online/ready/busy`, `workerId`, `lastHeartbeatAt`). The operator targets one `deviceRef` or **all**; Central fans out one child per targeted device and never falls back to an unrelated tab or pool for a device-specific scan.

> **Enrollment UX — fast-follow.** v1 ships the *one-time invite → explicit redeem* flow above: the operator hands out a short-lived single-use link and the device redeems it into a durable binding. A planned fast-follow is **operator-approval enrollment**, where a generic Device Scan tab registers itself as an *unbound* online device and the console operator approves it into the case directly (Central pushes the binding credential to the already-connected device), removing the copy-paste link step. It needs a Central→online-edge credential-push command that is not built in v1; the invite/redeem model is the supported path today and the roster/fan-out routing consumes an authoritative `deviceRef` either way, so adding approval later does not change the routing contract.

### Provide the parent "brain" (a real Copilot worker)

The parent session needs a worker to run its turns and fire the delegate tool. The default local path is the existing **`poc-docker-copilot` WorkerPool**, selected by `{ agent: copilot, storage: volume-snapshot }`. Each queued case receives a no-reuse, session-pinned Docker worker running the real `CopilotProcessAdapter`; the scripted harness below remains deterministic test support only.

- **A. Local Docker WorkerPool — default.** In the Central shell, use placeholders for resource-specific values and build the sidecar image before starting the runtime:

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

  Central forwards the provider configuration to each sidecar container and mounts the host Azure CLI profile for `DefaultAzureCredential`; no connection string, provider token, or generated public URL belongs in the repo. A second console queues a second pool instance automatically.

- **B. Standalone real Copilot worker — optional debugging path.** A manually started `copilot-process-wrapper` sidecar with labels `{"agent":"copilot","storage":"volume-snapshot"}` satisfies the same parent AgentSpec, but it has fixed manual capacity. The root README documents standalone workers; use the Docker pool above for the primary multi-console flow.

- **C. Scripted offline harness (no Copilot provider) — test/demo only.** A deterministic stand-in for a no-Copilot two-tab demo. It is **not** a reasoning agent: it registers a real `SidecarDaemon` worker whose scripted adapter fires `scan_device_evidence` on each instruction, driving the exact delegation path without a model. Never use it as the production parent.

  ```powershell
  $env:CENTRAL_URL = 'http://localhost:3000'
  $env:TENANT_ID = 'poc'
  pnpm --dir samples/edge-worker dev:offline-parent
  ```

## Two-device (or two-tab) demo

1. Open the **console**: `http://127.0.0.1:5176/?role=console&central=http://localhost:3000&tenant=poc`. If the connection pill shows `error`, open **Connection** and set the correct Central URL. Press **Start recovery session** to create the `network-recovery-expert` parent (the case).
2. In the **Pair an edge device** card press **Create pairing invite**, then copy the one-time link and open it on a **phone** (or a second browser tab). The link carries `?role=edge` + connection settings in the query and the invite secret **only in the `#pair=…` fragment**.
3. On the **Device Scan** page press **Enroll & join**. The tab mints its `deviceId`, redeems the invite into a durable binding, and registers as a Worker. The camera stays off. The console's **Paired edge devices** list shows it as `online · ready` right away — before any scan.
4. To add a second device, mint **another** invite and open it on the next phone/tab; it joins the same case roster. Every device on a case must be minted from **the same console/case** — the console header shows the active **case id**, and each invite card repeats it. A tab that already holds a binding for one case will **not** silently switch when opened with a different case's invite: the Device Scan page shows an explicit **binding conflict** and blocks Join, offering to keep and reconnect its current case instead (see *Honest browser limitations*).
5. In the console, choose a **Scan target** (a specific device, or **All paired devices**) and send an instruction (e.g. **Check indicator lights**). The parent agent calls `scan_device_evidence` with that target; Central routes one child scan per targeted device, and a **Capture requested** card appears on each.
6. On each Device Scan page:
   - **Open camera → Capture frame** on a phone, or
   - **Use sample frame** on a desktop / when the camera is unavailable.

   The frame is analysed locally; the structured observation shows in the edge **Last local analysis** card and flows back to the parent, appearing per-device in the console evidence timeline and feeding the **Rolled-up diagnosis**. If a targeted device drops mid-scan, its child fails deterministically (never re-routed to another device) and the console shows an explicit **Retry scan**.

## How the SDK integration works

- **It is a real delegation, not a parallel architecture.** The console never talks to the browser worker directly. It creates the `network-recovery-expert` parent and observes the children the runtime creates when the agent calls `scan_device_evidence`. The delegate, callee AgentSpec, and label routing are the runtime's own Delegation mechanism (`config/delegates/device-scan-capture.json`).
- **The scan target is trusted, typed control metadata — not text in the prompt.** When the operator picks a device or **all**, the console sends it as the turn's structured `delegationTarget` field on `parent.send({ message, delegationTarget })` (an `{ scope: 'all' } | { deviceRef } | { deviceRefs: [...] }`), alongside the plain-language instruction. Central durably binds that target to the accepted turn and enforces it authoritatively when the matching `scan_device_evidence` delegate fires: the agent may echo the same target but cannot widen or redirect it (a mismatch is rejected as `delegation_rejected`), and the constraint is scoped to that one turn so concurrent/queued turns cannot leak targets across each other. The device-scan delegate has `targetPolicy: 'device'`, so an absent target is never silently pool-routed. The scripted dev harness reads the same typed field — there is no natural-language directive for the model to reproduce.
- **Pairing and the roster are typed client APIs.** The console uses `client.cases.createPairingInvite(caseId)` and `client.cases.listDevices(caseId)` — tenant- and case-scoped read models that return only this case's authorized devices. It never scrapes worker labels or infers presence from child sessions.
- **Registration is the real worker handshake, gated by the binding.** `EdgeWorkerRuntime.register()` POSTs a `WorkerRegisterPayload` (including the `edgeBinding`) to `/sidecar/negotiate?tenantId=...`, connects the returned Web PubSub URL, subscribes to its `worker-commands` group, and heartbeats `conditions: ['ready']`. Central validates the binding credential and mints the routing labels; the tab cannot self-assert its `case`/`deviceRef`.
- **The edge agent is a local device probe.** `CameraDiagnosticAgent` parses the scan task, enforces capability scope, delegates capture to a user-gesture `CaptureProvider`, runs the local analyzers, and returns bounded structured evidence (`kind: 'device-evidence'`). It never raises a Central-mediated interaction — capture consent is resolved on the device inside the turn.
- **Privacy is enforced in one place.** `createAnalyzerCaptureProvider` is the only bridge from a raw `EdgeFrame` to a `FrameAnalysis`; by construction it returns structured signals and media metadata, never pixels. Raw/cropped image upload only happens through `maybeShareImage`, which is off in this sample and requires a separate per-capture authorization created by the phone UI. A remote task cannot grant its own consent.

## Local analysis (not a browser VLM)

The default analyzers compute real optical signals from RGBA pixels with bounded, deterministic arithmetic and no model download or network call:

- `CanvasHeuristicAnalyzer` — brightness / mean luma, exposure clipping, contrast, colour balance and estimated colour temperature, sharpness via Laplacian variance → focus score, glare via a flood-filled hotspot.
- `LedIndicatorAnalyzer` — connected-component LED blob detection and colour classification (red / amber / green / blue / white) with a blink tracker.
- `BrowserBarcodeScanner` — the **native** `BarcodeDetector` for QR / barcodes when the browser exposes it, with an **honest degradation** notice (`supported: false`) when it does not. No barcode library is bundled and no result is faked.

`FrameAnalyzer` is the model-adapter seam: a future WebGPU / ONNX / WebNN analyzer implements the same interface without touching the worker or the console. Device-model semantics and the final diagnosis are the cloud agent's job, not the browser's.

## Weak-network behaviour

- Structured JSON is the default (and only) payload; the raw frame stays on the device.
- If the connection drops, `EdgeWorkerRuntime` saves each structured result in a `localStorage` outbound queue (`LocalStorageOutboundQueueStore`) and replays it to the same session on reconnect.
- The Device Scan UI shows connected / queued / synced state and a manual retry-sync control.

## Honest browser limitations

- **Not a daemon.** The worker *is* the tab. Closing it — or backgrounding it past the runtime's orphan/idle timeout — suspends the worker. The durable session survives; on reconnect the tab re-registers with its **stored binding credential** (not the one-time invite), so it rejoins the same case as the same `deviceRef` without re-pairing.
- **Camera needs a secure context.** `getUserMedia` only works on `https://` or `localhost`. A phone opening this over plain LAN `http://` cannot open the live camera; use a temporary HTTPS reverse proxy without committing its generated public URL, or use the **sample-frame** fallback.
- **Consent is local and per-capture.** A routed task never auto-opens the camera. It only shows a card; the frame is captured after an explicit tap and can be declined.
- **A device belongs to one case at a time.** The Device Scan tab stores exactly one binding. Opening it with an invite for a *different* case surfaces an explicit **binding conflict** — current case/`deviceRef` vs invited case — and blocks Join rather than overwriting local storage and leaving an orphaned Central binding. v1 offers a safe **Keep current case & reconnect** action; an authenticated self-release/switch that first revokes the old Central binding is a documented fast-follow. To move a device between cases today, close the old case (which revokes its bindings) or clear the tab's storage, then redeem the new invite.
- **The console won't let you instruct before there's a worker.** A parent turn fails with `no_current_worker` if it has no worker attached, so the console disables the instruction box until the case's parent is actually assigned and `running`, showing **waiting for parent capacity** meanwhile. A manually started sidecar or the offline scripted harness has fixed capacity; the default no-reuse Docker WorkerPool creates one session-pinned worker per queued case.
- **Credential storage is only as strong as the browser.** The device's `deviceId` and its bearer binding credential live in `localStorage` — the narrowest durable store that survives a reload/reconnect. That means script running in the page origin (an XSS bug) could read the credential; treat it as a session-scoped secret, serve the page from a trusted origin over HTTPS, and rely on `revokeDevice`/case-close revocation to cut off a leaked credential. Hardware-backed keys (WebAuthn/`CryptoKey` with `extractable:false`) are the upgrade path, not implemented in v1.
- **POC tenant scoping.** For demo convenience the sample passes `tenant=poc` in the query string, and the POC HTTP routes read `tenantId` from the query. This is **not** the authorization boundary: an invite is only redeemable with its one-time secret against the tenant/case it was minted for, and a binding only authorizes with its credential — a mismatched tenant simply fails as `invite_not_found`/`binding_not_found`. A production deployment would derive `tenantId` from an authenticated identity, not the query.

## Validate

```powershell
pnpm --dir sdk/client build           # roster + pairing client APIs the console uses
pnpm --dir sdk/edge-worker typecheck
pnpm --dir sdk/edge-worker test        # analyzer, camera-agent, weak-network runtime unit tests
pnpm --dir sdk/edge-worker test:package # CommonJS require + native Node ESM import
pnpm --dir samples/edge-worker test    # console/Device Scan UI helper unit tests
pnpm --dir samples/edge-worker build   # tsc + vite build
```

The full parent-turn → delegate → per-device child scan → structured-result loop — including one-time invite redemption, Central-minted binding, single-device vs fan-out (`target: all`) routing, and lost-device fail/retry — is proven against the real `CentralService` in `tests/edge/delegation-network-recovery.integration.test.ts` (run by `pnpm test` from the repo root).
