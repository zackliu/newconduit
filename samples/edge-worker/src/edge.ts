import {
  BrowserBarcodeScanner,
  CameraDiagnosticAgent,
  CanvasHeuristicAnalyzer,
  EdgeWorkerRuntime,
  LedIndicatorAnalyzer,
  LocalStorageOutboundQueueStore,
  WebPubSubEdgeWorkerTransport,
  createAnalyzerCaptureProvider,
  createCodeObserver,
  redeemPairingInvite,
  type CaptureRequest,
  type CodeObservation,
  type DeviceObservation,
  type EdgeBindingPayload,
  type EdgeDeviceManifest,
  type EdgeWorkerLifecycleEvent,
  type FrameAnalysis,
  type FrameProvider,
  type FrameProviderResult,
  type LedIndicatorObservation
} from '@agent-runtime-sidecar/edge-worker';
import { BrowserCamera, buildManifest, cameraAvailability, hasBarcodeDetector, sampleFrame } from './camera';
import { persist, type DemoConfig, type PairingInvite } from './config';
import {
  getOrCreateDeviceId,
  readBinding,
  storeBinding,
  type DeviceBinding
} from './device-identity';
import { errorMessage, esc, fmtPct, severityClass, shortId, timestamp, computeJoinGate } from './ui';

type WorkerStatus = 'idle' | 'registering' | 'reregistering' | 'ready' | 'assigned' | 'running' | 'paused' | 'error';
type TransportState = 'unknown' | 'connected' | 'disconnected';

interface PendingCapture {
  request: CaptureRequest;
  resolve: (result: FrameProviderResult) => void;
  signal: AbortSignal;
  cameraOpen: boolean;
  cameraError?: string;
}

interface LogLine {
  ts: string;
  text: string;
  tone: 'info' | 'good' | 'warn' | 'bad';
}

interface EdgeState {
  config: DemoConfig;
  centralUrl: string;
  tenantId: string;
  deviceLabel: string;
  deviceId: string;
  binding?: DeviceBinding;
  invite?: PairingInvite;
  manifest: EdgeDeviceManifest;
  runtime?: EdgeWorkerRuntime;
  workerId?: string;
  status: WorkerStatus;
  connection: 'idle' | 'connecting' | 'connected' | 'error';
  transportState: TransportState;
  pendingResults: number;
  lastSync?: string;
  lifecycle: LogLine[];
  pending?: PendingCapture;
  lastAnalysis?: FrameAnalysis;
  lastObservations: DeviceObservation[];
  lastHeartbeat?: string;
  error: string;
  settingsOpen: boolean;
}

let root: HTMLElement;
let state: EdgeState;
const camera = new BrowserCamera();
let renderScheduled = false;

export function mountEdge(mountRoot: HTMLElement, config: DemoConfig): void {
  root = mountRoot;
  camera.video.className = 'camPreview';
  state = {
    config,
    centralUrl: config.centralUrl,
    tenantId: config.tenantId,
    deviceLabel: config.deviceLabel,
    deviceId: getOrCreateDeviceId(),
    binding: readBinding(),
    invite: config.invite,
    manifest: buildManifest(config.deviceLabel),
    status: 'idle',
    connection: 'idle',
    transportState: 'unknown',
    pendingResults: 0,
    lifecycle: [],
    lastObservations: [],
    error: '',
    settingsOpen: false
  };
  render();
}

/* ---------- runtime wiring ---------- */

const frameProvider: FrameProvider = (request, context) =>
  new Promise<FrameProviderResult>((resolve) => {
    const pending: PendingCapture = { request, resolve, signal: context.signal, cameraOpen: false };
    state.pending = pending;
    const onAbort = (): void => {
      if (state.pending === pending) {
        state.pending = undefined;
        camera.stop();
        resolve({ status: 'aborted', reason: 'Capture aborted before the frame was taken.' });
        render();
      }
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
    render();
  });

function buildRuntime(): EdgeWorkerRuntime {
  const captureProvider = createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), frameProvider, {
    observers: [new LedIndicatorAnalyzer(), createCodeObserver(new BrowserBarcodeScanner())]
  });
  const agent = new CameraDiagnosticAgent({
    captureProvider,
    manifestProvider: () => buildManifest(state.deviceLabel)
  });
  return new EdgeWorkerRuntime({
    transport: new WebPubSubEdgeWorkerTransport({ tenantId: state.tenantId }),
    agent,
    observer: onLifecycle,
    outboundQueue: localStorageQueue()
  });
}

/**
 * A durable, `localStorage`-backed outbound result queue. Completed structured observations are persisted here
 * until central acknowledges them, so a weak-network drop, a suspended tab, or a reload never loses a result —
 * the runtime replays the queue on reconnect. Falls back to an in-memory store when storage is unavailable.
 */
function localStorageQueue(): LocalStorageOutboundQueueStore | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return new LocalStorageOutboundQueueStore(localStorage, `rnr.edge.queue.${state.tenantId}`);
  } catch {
    return undefined;
  }
}

function onLifecycle(event: EdgeWorkerLifecycleEvent): void {
  switch (event.type) {
    case 'registered':
      state.workerId = event.worker.workerId;
      state.status = 'ready';
      log('good', `Registered as worker ${event.worker.workerId}`);
      break;
    case 'heartbeat':
      state.lastHeartbeat = timestamp();
      if (state.status === 'idle' || state.status === 'registering') state.status = 'ready';
      break;
    case 'transport':
      state.transportState = event.state;
      if (event.state === 'connected') {
        if (state.connection === 'connecting') state.connection = 'connected';
        log('good', 'Realtime transport connected');
      } else {
        // An honest disconnect: never keep showing a healthy "ready/connected" worker while the transport is down.
        if (state.status === 'ready' || state.status === 'assigned' || state.status === 'running') {
          state.status = 'reregistering';
        }
        log('warn', 'Realtime transport dropped — results will queue locally until it recovers');
      }
      break;
    case 're-registering':
      // This tab's worker id expired (it was backgrounded/suspended past its keepalive). The runtime is
      // re-registering a fresh worker under the same pairing; surface it honestly instead of looking online.
      state.status = 'reregistering';
      state.workerId = undefined;
      state.lastHeartbeat = undefined;
      log('warn', `Reconnecting this device — ${event.reason}`);
      break;
    case 'session.assigned':
      state.status = 'assigned';
      log('info', `Session assigned (${event.agentSpecId})`);
      break;
    case 'session.running':
      state.status = 'running';
      log('good', 'Session running — ready to receive capture tasks');
      break;
    case 'turn.started':
      log('info', `Task received: ${describeTask(event.message)}`);
      break;
    case 'turn.progress':
      log('info', event.text);
      break;
    case 'turn.completed':
      applyLocalAnalysis(event.output);
      log('good', `Result computed${event.message ? `: ${event.message}` : ''}`);
      break;
    case 'turn.replayed':
      log('info', `Turn #${event.turnSeq} already completed — replaying stored result without re-capturing`);
      break;
    case 'result.queued':
      state.pendingResults = event.pending;
      log('warn', `Result #${event.turnSeq} queued locally (offline) — ${event.pending} pending`);
      break;
    case 'result.synced':
      state.pendingResults = event.pending;
      state.lastSync = timestamp();
      log('good', `Result #${event.turnSeq} synced to central — ${event.pending} pending`);
      break;
    case 'turn.failed':
      log('bad', `Turn failed: ${event.error}`);
      break;
    case 'session.paused':
      state.status = 'paused';
      state.pending = undefined;
      camera.stop();
      log('warn', `Session paused${event.reason ? `: ${event.reason}` : ''}`);
      break;
    case 'command.rejected':
      log('warn', `Command rejected: ${event.reason}`);
      break;
    case 'stopped':
      state.status = 'idle';
      log('info', 'Worker stopped');
      break;
    case 'error':
      state.error = event.message;
      log('bad', event.message);
      break;
    default:
      break;
  }
  scheduleRender();
}

function applyLocalAnalysis(output: unknown): void {
  if (isRecord(output) && output.kind === 'device-evidence') {
    if (isRecord(output.analysis)) state.lastAnalysis = output.analysis as unknown as FrameAnalysis;
    if (Array.isArray(output.observations)) state.lastObservations = output.observations as DeviceObservation[];
  }
}

async function join(): Promise<void> {
  if (state.status === 'ready' || state.status === 'running' || state.connection === 'connecting') return;
  const gate = computeJoinGate({ hasBinding: Boolean(state.binding), hasInvite: Boolean(state.invite) });
  // A device that is already bound AND holding a fresh invite is an explicit conflict: the invite was minted from a
  // different console/case. Never silently drop it and reconnect the old case, and never overwrite the binding
  // client-side (that orphans the old Central binding). Force an explicit operator choice via the conflict card.
  if (gate === 'conflict') {
    state.error =
      `This device is already paired to recovery case ${shortId(state.binding!.caseId)}. The pairing invite you opened is for a different console/case and was not applied. ` +
      `Choose “Keep case ${shortId(state.binding!.caseId)} & reconnect” to stay on the current case, or close/complete that case from its console before re-pairing this device elsewhere.`;
    render();
    return;
  }
  state.connection = 'connecting';
  state.status = 'registering';
  state.error = '';
  render();
  try {
    // Redeem a one-time invite into a durable Central binding on first join (needs a user gesture / explicit Join).
    if (gate === 'invite') {
      await enroll(state.invite!);
    }
    if (!state.binding) {
      throw new Error(
        'This device is not paired to a recovery case yet. Open the one-time pairing link from the Network Recovery Console on this device, then Join.'
      );
    }
    const runtime = buildRuntime();
    const edgeBinding: EdgeBindingPayload = {
      caseId: state.binding.caseId,
      deviceId: state.deviceId,
      deviceRef: state.binding.deviceRef,
      bindingCredential: state.binding.bindingCredential
    };
    // Base capability labels only — Central mints the authoritative {case, deviceRef} routing labels from the
    // binding credential and rejects any client-sent case/deviceRef, so a tab cannot self-assert its routing.
    await runtime.register({
      centralUrl: state.centralUrl,
      tenantId: state.tenantId,
      labels: { agent: 'browser-edge', tier: 'edge', role: 'device-scan-probe', storage: 'host-managed' },
      storageClass: 'host-managed',
      capacity: 1,
      description: { deviceLabel: state.deviceLabel },
      edgeBinding
    });
    state.runtime = runtime;
    state.connection = 'connected';
  } catch (error) {
    state.connection = 'error';
    state.status = 'error';
    state.error = errorMessage(error);
  }
  render();
}

/**
 * Exchange the one-time invite for a durable, Central-authoritative case binding. The invite is consumed here and
 * never reused: reconnect/reload re-registers with the stored `bindingCredential`, not the invite.
 */
async function enroll(invite: PairingInvite): Promise<void> {
  const result = await redeemPairingInvite({
    centralUrl: state.centralUrl,
    tenantId: state.tenantId,
    inviteId: invite.inviteId,
    inviteSecret: invite.inviteSecret,
    deviceId: state.deviceId,
    deviceLabel: state.deviceLabel
  });
  const binding: DeviceBinding = {
    caseId: result.caseId,
    deviceRef: result.deviceRef,
    bindingCredential: result.bindingCredential
  };
  storeBinding(binding);
  state.binding = binding;
  state.invite = undefined;
  log('good', `Enrolled into case ${shortId(result.caseId)} as device ${shortId(result.deviceRef)}`);
}

/**
 * Resolve a binding conflict by KEEPING the current case: discard the freshly opened invite (it was for a different
 * console/case) and reconnect this device to the case it is already bound to. We deliberately do NOT switch cases
 * client-side — that would leave the old Central binding active and orphaned — so moving a device to a different
 * case remains an operator close-case flow, not a silent local swap.
 */
function keepCurrentCase(): void {
  if (!state.binding) return;
  state.invite = undefined;
  state.error = '';
  log('warn', `Discarded a new pairing invite — this device stays bound to case ${shortId(state.binding.caseId)}.`);
  void join();
}

async function leave(): Promise<void> {
  camera.stop();
  state.pending = undefined;
  try {
    await state.runtime?.stop();
  } catch (error) {
    state.error = errorMessage(error);
  }
  state.runtime = undefined;
  state.connection = 'idle';
  state.status = 'idle';
  render();
}

/* ---------- capture actions (user gestures) ---------- */

async function openCamera(): Promise<void> {
  const pending = state.pending;
  if (!pending) return;
  pending.cameraError = undefined;
  try {
    await camera.open(pending.request.source, pending.signal);
    if (state.pending !== pending) {
      camera.stop();
      return;
    }
    pending.cameraOpen = true;
  } catch (error) {
    if (state.pending !== pending) return;
    pending.cameraError = errorMessage(error);
    pending.cameraOpen = false;
  }
  render();
}

function captureFromCamera(): void {
  const pending = state.pending;
  if (!pending) return;
  const frame = camera.grabFrame();
  if (!frame) {
    pending.cameraError = 'No camera frame is ready yet — hold steady and try again.';
    render();
    return;
  }
  resolvePending({
    status: 'captured',
    captured: { frame, source: pending.request.source, sampleSource: 'camera', facingMode: camera.facing }
  });
  camera.stop();
}

function captureFromSample(): void {
  const pending = state.pending;
  if (!pending) return;
  const frame = sampleFrame(pending.request.source);
  resolvePending({
    status: 'captured',
    captured: { frame, source: pending.request.source, sampleSource: 'sample-image' }
  });
  camera.stop();
}

function declineCapture(): void {
  const pending = state.pending;
  if (!pending) return;
  resolvePending({ status: 'declined', reason: 'The device operator declined this capture.' });
  camera.stop();
}

function resolvePending(result: FrameProviderResult): void {
  const pending = state.pending;
  if (!pending) return;
  state.pending = undefined;
  pending.resolve(result);
  render();
}

/* ---------- render ---------- */

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render(): void {
  const avail = cameraAvailability();
  root.innerHTML = `
    <div class="shell edge">
      <header class="topbar">
        <div class="brand">
          <div class="mark">◇</div>
          <div>
            <div class="brandName">Device Scan</div>
            <div class="brandSub">Browser Edge Worker · Remote Network Recovery</div>
          </div>
        </div>
        <div class="topActions">
          <span class="pill st-${esc(state.status)}">${esc(state.status)}</span>
          <button class="ghostBtn" id="toggleSettings">Settings</button>
        </div>
      </header>

      ${privacyBanner()}
      ${pairingBanner()}
      ${state.settingsOpen ? settingsPanel() : ''}
      ${state.error ? `<div class="banner error">${esc(state.error)}</div>` : ''}

      <main class="edgeMain">
        ${joinCard()}
        ${syncCard()}
        ${captureCard(avail)}
        ${manifestCard()}
        ${state.lastAnalysis ? localAnalysisCard(state.lastAnalysis) : ''}
        ${lifecycleCard()}
      </main>
      <footer class="foot">This tab is the worker. Raw frames are analysed on-device and discarded; only structured results are sent. Closing or backgrounding the tab suspends the worker.</footer>
    </div>`;
  mountVideo();
  wireEdge();
}

function privacyBanner(): string {
  const live = camera.isLive;
  const cls = live ? 'privacy live' : 'privacy';
  const text = live
    ? 'Camera active — frames are analysed locally and never uploaded.'
    : 'Camera is off. It only turns on when you explicitly authorize a capture task.';
  return `<div class="${cls}"><span class="lock">🔒</span>${esc(text)}</div>`;
}

function pairingBanner(): string {
  const gate = computeJoinGate({ hasBinding: Boolean(state.binding), hasInvite: Boolean(state.invite) });
  if (gate === 'conflict') {
    return `<div class="banner warn small"><b>Binding conflict.</b> This device is already paired to recovery case ${esc(shortId(state.binding!.caseId))}, and the pairing link you just opened is for a different case — so it was <b>not</b> applied. Reconnect to case ${esc(shortId(state.binding!.caseId))} below, or close that case from its console first to re-pair this device.</div>`;
  }
  if (state.binding) return '';
  if (state.invite) {
    return '<div class="banner small">Pairing invite detected. Press “Join as edge device” to enroll this device into the recovery case.</div>';
  }
  return '<div class="banner warn small">This tab is not bound to a recovery case. Open the one-time pairing link from the Network Recovery Console on this device so delegated scans route here.</div>';
}

function joinCard(): string {
  const joined = state.status !== 'idle' && state.status !== 'error';
  const gate = computeJoinGate({ hasBinding: Boolean(state.binding), hasInvite: Boolean(state.invite) });
  const conflict = gate === 'conflict';
  const hb = state.lastHeartbeat ? `<div class="kv"><span>Last heartbeat</span><code>${esc(state.lastHeartbeat)}</code></div>` : '';
  const bindingRows = state.binding
    ? `<div class="kv"><span>Recovery case</span><code>${esc(shortId(state.binding.caseId))}</code></div>
       <div class="kv"><span>Device ref</span><code>${esc(shortId(state.binding.deviceRef))}</code></div>`
    : `<div class="kv"><span>Pairing</span><code>${state.invite ? 'invite ready — Join to enroll' : 'not paired'}</code></div>`;
  const joinLabel = state.binding ? 'Join as edge device' : state.invite ? 'Enroll & join' : 'Join as edge device';
  const busyConnecting = state.connection === 'connecting';
  let actionRow: string;
  if (joined) {
    actionRow = '<button class="dangerBtn" id="leaveBtn">Leave session</button>';
  } else if (conflict) {
    actionRow = `<button class="primaryBtn" id="keepCaseBtn" ${busyConnecting ? 'disabled' : ''}>${busyConnecting ? 'Joining…' : `Keep case ${esc(shortId(state.binding!.caseId))} &amp; reconnect`}</button>`;
  } else {
    actionRow = `<button class="primaryBtn" id="joinBtn" ${busyConnecting ? 'disabled' : ''}>${busyConnecting ? 'Joining…' : joinLabel}</button>`;
  }
  const footNote = conflict
    ? `<p class="muted small">The invite you opened is for a <b>different</b> case and was not applied. To move this device to that case, close/complete case <code>${esc(shortId(state.binding!.caseId))}</code> from its console (which revokes this binding), then reopen the new link. A self-service device switch is a planned enrichment; v1 never orphans a binding by swapping it locally.</p>`
    : '<p class="muted small">Joining registers this tab as a Worker for the tenant, bound to its recovery case via a Central-minted credential. The camera stays off until a task asks for it.</p>';
  return `
    <div class="card">
      <div class="cardHead"><h2>Join as edge device</h2>${connectionPill()}</div>
      <div class="kv"><span>Central</span><code>${esc(state.centralUrl)}</code></div>
      <div class="kv"><span>Tenant</span><code>${esc(state.tenantId)}</code></div>
      <div class="kv"><span>Device id</span><code>${esc(shortId(state.deviceId))}</code></div>
      ${bindingRows}
      <div class="kv"><span>Worker</span><code>${esc(state.workerId ?? '—')}</code></div>
      ${hb}
      <div class="row">
        ${actionRow}
      </div>
      ${footNote}
    </div>`;
}

function captureCard(avail: ReturnType<typeof cameraAvailability>): string {
  const pending = state.pending;
  if (!pending) {
    const waiting = state.status === 'running'
      ? 'Waiting for the console to route a capture task…'
      : 'Join and let the console route a task to receive capture requests.';
    return `
      <div class="card captureCard idle">
        <div class="cardHead"><h2>Capture task</h2></div>
        <div class="empty">${esc(waiting)}</div>
      </div>`;
  }
  const req = pending.request;
  const canLiveCamera = avail.usable;
  return `
    <div class="card captureCard active">
      <div class="cardHead"><h2>Capture requested</h2><span class="pill st-running">action needed</span></div>
      <div class="taskAsk">
        <div class="taskAskTarget">${esc(req.target)}</div>
        <div class="taskAskMeta">${esc(req.source)} camera${req.reason ? ` · ${esc(req.reason)}` : ''}</div>
      </div>
      <div class="previewSlot" id="previewSlot">${pending.cameraOpen ? '' : previewPlaceholder(avail)}</div>
      ${pending.cameraError ? `<div class="banner warn small">${esc(pending.cameraError)}</div>` : ''}
      <div class="captureActions">
        ${pending.cameraOpen
          ? '<button class="primaryBtn" id="shootBtn">Capture frame</button>'
          : canLiveCamera
            ? '<button class="primaryBtn" id="openCamBtn">Open camera</button>'
            : ''}
        <button class="secondaryBtn" id="sampleBtn">Use sample frame</button>
        <button class="ghostBtn" id="declineBtn">Decline</button>
      </div>
      <p class="muted small">Consent is resolved on this device. Only structured analysis is returned to the cloud session — the frame is discarded after analysis.</p>
    </div>`;
}

function previewPlaceholder(avail: ReturnType<typeof cameraAvailability>): string {
  if (avail.usable) return '<div class="previewHint">Press “Open camera”, frame the subject, then capture.</div>';
  return `<div class="previewHint warn">${esc(avail.reason ?? 'Camera unavailable.')}<br/>Use the sample frame to still produce a local analysis.</div>`;
}

function syncCard(): string {
  const joined = state.status !== 'idle' && state.connection !== 'idle';
  if (!joined) return '';
  const transportLabel: Record<TransportState, string> = {
    unknown: 'connecting…',
    connected: 'online',
    disconnected: 'offline — queuing locally'
  };
  const transportCls = state.transportState === 'connected' ? 'good' : state.transportState === 'disconnected' ? 'bad' : 'warn';
  const pending = state.pendingResults;
  const pendingCls = pending > 0 ? 'warn' : 'good';
  return `
    <div class="card syncCard">
      <div class="cardHead"><h2>Weak-network sync</h2><span class="pill sync-${transportCls}">${transportLabel[state.transportState]}</span></div>
      <div class="deviceGrid">
        <div class="kv"><span>Transport</span><code>${esc(state.transportState)}</code></div>
        <div class="kv"><span>Queued results</span><code class="q-${pendingCls}">${pending}</code></div>
        <div class="kv"><span>Last sync</span><code>${esc(state.lastSync ?? '—')}</code></div>
      </div>
      <div class="row">
        <button class="secondaryBtn" id="retrySyncBtn" ${pending > 0 ? '' : 'disabled'}>Retry sync now</button>
      </div>
      <p class="muted small">Structured results are persisted on this device and replayed when the connection recovers — nothing is lost when the network drops, the tab reloads, or the worker is reassigned.</p>
    </div>`;
}

function manifestCard(): string {
  const m = state.manifest;
  const detectorText = m.detectors?.length ? m.detectors.map((d) => d.displayName).join(', ') : 'none';
  const barcodeNote = hasBarcodeDetector()
    ? 'Native barcode/QR decoding is available.'
    : 'No native BarcodeDetector — barcode/QR degrades to manual entry (never faked).';
  return `
    <div class="card">
      <div class="cardHead"><h2>Capability manifest</h2></div>
      <div class="deviceGrid">
        <div class="kv"><span>Device</span><code>${esc(m.deviceLabel)}</code></div>
        <div class="kv"><span>Secure context</span><code>${m.secureContext ? 'yes' : 'no'}</code></div>
        <div class="kv"><span>Capture scope</span><code>${m.captureSources.length ? esc(m.captureSources.join(', ')) : 'sample-frame only'}</code></div>
        <div class="kv"><span>Analyzer</span><code>${esc(m.analyzers.map((a) => a.displayName).join(', '))}</code></div>
        <div class="kv"><span>Detectors</span><code>${esc(detectorText)}</code></div>
        <div class="kv"><span>Raw media</span><code>stays on device</code></div>
      </div>
      <p class="muted small">${esc(barcodeNote)}</p>
      ${m.notes?.length ? `<ul class="notes">${m.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </div>`;
}

function observationsBlock(): string {
  if (!state.lastObservations.length) return '';
  const parts: string[] = [];
  const led = state.lastObservations.find((o): o is LedIndicatorObservation => o.kind === 'led-indicator');
  const code = state.lastObservations.find((o): o is CodeObservation => o.kind === 'code');
  if (led) {
    const chips = led.indicators.length
      ? led.indicators
          .slice(0, 6)
          .map((i) => `<span class="ledChip led-${esc(i.color)}">${esc(i.color)} · ${fmtPct(i.areaPct)}</span>`)
          .join('')
      : '<span class="muted small">No lit indicators detected.</span>';
    parts.push(`<div class="obsRow"><div class="obsKey">LED indicators</div><div class="obsVal">${chips}</div></div>`);
  }
  if (code) {
    const codeVal = !code.supported
      ? '<span class="badge sev-warn">unsupported — manual entry</span>'
      : code.codes.length
        ? code.codes.slice(0, 4).map((c) => `<code>${esc(c.format)}: ${esc(c.value)}</code>`).join(' ')
        : '<span class="muted small">No barcode/QR in frame.</span>';
    parts.push(`<div class="obsRow"><div class="obsKey">Barcode / QR</div><div class="obsVal">${codeVal}</div></div>`);
  }
  return parts.length ? `<div class="obsList">${parts.join('')}</div>` : '';
}

function localAnalysisCard(a: FrameAnalysis): string {
  const s = a.signals;
  const rows: [string, string][] = [
    ['Quality', fmtPct(a.qualityScore)],
    ['Brightness', fmtPct(s.brightness.normalized)],
    ['Focus', fmtPct(s.sharpness.focusScore)],
    ['Glare', fmtPct(s.glare.hotspotPct)],
    ['Colour', `${s.colorBalance.temperatureLabel} · ~${s.colorBalance.estimatedKelvin}K`]
  ];
  return `
    <div class="card">
      <div class="cardHead"><h2>Last local analysis</h2><span class="badge sev-ok">on-device</span></div>
      <div class="evMsg">${esc(a.summary)} <b>${esc(a.recommendation)}</b></div>
      <div class="signalGrid">
        ${rows.map(([k, v]) => `<div class="sigCell"><div class="sigKey">${esc(k)}</div><div class="sigVal">${esc(v)}</div></div>`).join('')}
      </div>
      ${a.findings.length ? `<ul class="findingList">${a.findings.map((f) => `<li class="finding ${severityClass(f.severity)}"><span class="dot"></span><b>${esc(f.label)}</b> — ${esc(f.detail)}</li>`).join('')}</ul>` : ''}
      ${observationsBlock()}
      <p class="muted small">This is exactly what the cloud session receives — computed here, structured, no pixels.</p>
    </div>`;
}

function lifecycleCard(): string {
  const lines = [...state.lifecycle].slice(-40).reverse();
  return `
    <div class="card">
      <div class="cardHead"><h2>Worker lifecycle</h2><span class="count">${state.lifecycle.length}</span></div>
      ${lines.length ? `<div class="log">${lines.map((l) => `<div class="logLine ${l.tone}"><span class="logTs">${esc(l.ts)}</span>${esc(l.text)}</div>`).join('')}</div>` : '<div class="empty small">No events yet.</div>'}
    </div>`;
}

function connectionPill(): string {
  const map: Record<EdgeState['connection'], string> = {
    idle: 'not joined',
    connecting: 'joining…',
    connected: 'connected',
    error: 'error'
  };
  return `<span class="pill conn-${state.connection}">${map[state.connection]}</span>`;
}

function settingsPanel(): string {
  return `
    <div class="card settings">
      <div class="cardHead"><h2>Connection</h2></div>
      <label>Central URL<input id="centralUrl" value="${esc(state.centralUrl)}" /></label>
      <label>Tenant<input id="tenantId" value="${esc(state.tenantId)}" /></label>
      <label>Device label<input id="deviceLabel" value="${esc(state.deviceLabel)}" /></label>
      <div class="row"><button class="primaryBtn" id="saveSettings">Save</button></div>
      <p class="muted small">Leave the session before changing the endpoint.</p>
    </div>`;
}

/* ---------- dom glue ---------- */

function mountVideo(): void {
  const slot = root.querySelector('#previewSlot');
  if (slot && state.pending?.cameraOpen) {
    slot.appendChild(camera.video);
  }
}

function wireEdge(): void {
  root.querySelector('#joinBtn')?.addEventListener('click', () => void join());
  root.querySelector('#keepCaseBtn')?.addEventListener('click', () => keepCurrentCase());
  root.querySelector('#leaveBtn')?.addEventListener('click', () => void leave());
  root.querySelector('#retrySyncBtn')?.addEventListener('click', () => void state.runtime?.flushPendingResults());
  root.querySelector('#openCamBtn')?.addEventListener('click', () => void openCamera());
  root.querySelector('#shootBtn')?.addEventListener('click', () => captureFromCamera());
  root.querySelector('#sampleBtn')?.addEventListener('click', () => captureFromSample());
  root.querySelector('#declineBtn')?.addEventListener('click', () => declineCapture());
  root.querySelector('#toggleSettings')?.addEventListener('click', () => {
    state.settingsOpen = !state.settingsOpen;
    render();
  });
  root.querySelector('#saveSettings')?.addEventListener('click', () => {
    const central = root.querySelector<HTMLInputElement>('#centralUrl')?.value.trim();
    const tenant = root.querySelector<HTMLInputElement>('#tenantId')?.value.trim();
    const device = root.querySelector<HTMLInputElement>('#deviceLabel')?.value.trim();
    if (central) { state.centralUrl = central; persist('centralUrl', central); }
    if (tenant) { state.tenantId = tenant; persist('tenantId', tenant); }
    if (device) { state.deviceLabel = device; persist('deviceLabel', device); }
    state.manifest = buildManifest(state.deviceLabel);
    state.settingsOpen = false;
    render();
  });
}

/* ---------- helpers ---------- */

function log(tone: LogLine['tone'], text: string): void {
  state.lifecycle.push({ ts: timestamp(), text, tone });
}

function describeTask(message: string): string {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (parsed.task === 'manifest') return 'capability manifest';
    if (parsed.task === 'capture' && typeof parsed.target === 'string') return `capture ${parsed.target}`;
  } catch {
    /* not JSON */
  }
  return message.slice(0, 60);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
