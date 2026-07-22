# @agent-runtime-sidecar/edge-worker

Browser edge-worker SDK for the Agent Runtime Sidecar runtime. It registers a **web page as a real Worker** for a tenant and runs a local device-capture agent inside it — the browser peer of the Node `SidecarDaemon`.

It reuses the identical runtime contract as the Node sidecar:

- reverse-registers over `POST /sidecar/negotiate?tenantId=...` with a `WorkerRegisterPayload`;
- connects the returned Azure Web PubSub URL and heartbeats `conditions: ['ready']`;
- receives `session.assign` / `session.input` / `session.pause.requested` on its `worker-commands` group;
- publishes `status.changed` / `agent.output` / `turn.completed` / `session.paused` back to the tenant inbox;
- validates the `sessionLeaseId` and deduplicates turn inputs, exactly like the daemon.

A browser worker registers as `storageClass: 'host-managed'` and answers pause with no snapshot — continuity comes from the AgentSpec's restart-with-context, not a workspace snapshot.

## Honest hybrid edge/cloud split

The phone is a **lightweight, verifiable local probe**, not a vision-language model. On-device it does only what it can actually compute and check: user-gated capture, optical quality (framing / brightness / focus / glare), and optional lightweight observers (LED colour, barcode/QR). Semantic understanding ("which device is this, is this wiring correct, what to do next") is the cloud multimodal agent's job. By default only structured results are reported; an actual image leaves the device only through an explicit per-capture consent gate, after being cropped, privacy-masked, and downscaled. There is no bundled model dependency.

## Surface

```ts
import {
  EdgeWorkerRuntime,
  WebPubSubEdgeWorkerTransport,
  CameraDiagnosticAgent,
  CanvasHeuristicAnalyzer,
  createAnalyzerCaptureProvider,
  LedIndicatorAnalyzer,
  BrowserBarcodeScanner,
  createCodeObserver,
  createBrowserImageEncoder,
  type FrameProvider,
  type EdgeDeviceManifest
} from '@agent-runtime-sidecar/edge-worker';

const captureProvider = createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), frameProvider, {
  observers: [new LedIndicatorAnalyzer(), createCodeObserver(new BrowserBarcodeScanner())],
  imageSharing: { policy: 'on-explicit-consent', encoder: createBrowserImageEncoder() }
});
const agent = new CameraDiagnosticAgent({ captureProvider, manifestProvider });
const runtime = new EdgeWorkerRuntime({
  transport: new WebPubSubEdgeWorkerTransport({ tenantId }),
  agent,
  observer: (event) => { /* drive UI from lifecycle events */ }
});

await runtime.register({
  centralUrl,
  tenantId,
  labels: { agent: 'browser-edge', tier: 'edge', role: 'device-scan-probe', storage: 'host-managed' },
  storageClass: 'host-managed',
  capacity: 1
});
```

- **`EdgeWorkerRuntime`** — the worker lifecycle. `register()` for the browser HTTP path, `connectWithGrant()` for tests that drive a real Central without HTTP.
- **`EdgeWorkerTransport`** / `WebPubSubEdgeWorkerTransport` — injectable transport; the default is a browser-safe Web PubSub client. Tests inject an in-memory transport.
- **`EdgeAgent`** — the per-turn agent interface (`start` / `runTurn` / `stop`).
- **`CameraDiagnosticAgent`** — parses a routed JSON task, enforces capability scope, delegates capture to a user-gesture `CaptureProvider`, and returns bounded structured evidence. Never returns raw pixels; never raises a Central-mediated interaction.
- **`FrameAnalyzer`** / `CanvasHeuristicAnalyzer` — the local optical-inference seam. The default computes real optical signals (brightness, exposure, contrast, colour temperature, Laplacian-variance focus, glare) with bounded arithmetic and no model download. A future WebGPU/ONNX/WebNN analyzer implements the same interface.
- **`LocalObserver`** / `LedIndicatorAnalyzer` / `createCodeObserver` — the additive observation seam. Observers run **inside** the capture provider (where the frame legitimately exists) and emit small, image-free structured observations. `LedIndicatorAnalyzer` does real connected-component blob detection + colour classification (red/amber/green/blue); `LedBlinkTracker` classifies steady vs. blinking across successive captures. `createCodeObserver(new BrowserBarcodeScanner())` decodes barcodes/QR via the browser-native `BarcodeDetector`, reporting `supported: false` honestly where the API is absent.
- **`cropFrame` / `downscaleFrame` / `maskRegions`** — pure on-device frame processing used to crop to the relevant region, redact sensitive rectangles, and reduce size before any consented upload.
- **`maybeShareImage` / `createBrowserImageEncoder`** — the consent gate. No default encoder exists, so the share path cannot fire by accident; an image is produced only with `policy: 'on-explicit-consent'` + a request that carries `consent: true` + a wired encoder.
- **`createAnalyzerCaptureProvider`** — the single privacy boundary that turns an `EdgeFrame` into a `FrameAnalysis`, runs observers, applies the consent gate, and returns only structured media metadata (plus a consented artifact when explicitly granted).

## Task shape

The console routes ordinary session turns whose message is a small JSON task:

```jsonc
{ "task": "manifest" }
{ "task": "capture", "source": "environment", "target": "device panel", "reason": "check glare and focus" }
// run only specific local observers
{ "task": "capture", "target": "status LEDs", "detect": ["led-indicator", "code"] }
// explicitly consent to sharing a cropped, masked, downscaled image
{ "task": "capture", "target": "rating label", "share": { "consent": true, "scope": "rating label", "crop": { "x": 120, "y": 80, "width": 240, "height": 160 }, "mask": [{ "x": 0, "y": 0, "width": 60, "height": 24 }], "maxEdge": 1024 } }
```

`source` is `environment` (rear) or `user` (front). A non-JSON message is treated as a capture with the text used as the reason. `detect` filters which configured observers run (all when omitted). `share` is ignored unless `consent === true` **and** the device manifest advertises an `on-explicit-consent` image-sharing policy.

## Build & test

```powershell
pnpm --dir sdk/edge-worker build
pnpm --dir sdk/edge-worker typecheck
pnpm --dir sdk/edge-worker test
```

See [samples/edge-worker](../../samples/edge-worker) for a full two-role demo (console + phone edge device).
