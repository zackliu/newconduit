import {
  AgentRuntimeClient,
  type CaseDeviceView,
  type PairingInvite,
  type SessionEvent,
  type SessionHandle,
  type SessionStatus,
  type SessionSummary
} from '@agent-runtime-sidecar/sdk';
import type { EdgeDeviceManifest, FrameAnalysis, FrameFinding } from '@agent-runtime-sidecar/edge-worker';
import { buildEdgeInviteLink, persist, type DemoConfig } from './config';
import {
  computeDeviceStages,
  computeInstructionGate,
  computeScanRoute,
  errorMessage,
  esc,
  fmtPct,
  isTerminalChildStatus,
  severityClass,
  shortId,
  type DeviceStage,
  type InstructionGate,
  type ScanTarget
} from './ui';

/**
 * Network Recovery Console — the operator view of the DURABLE cloud recovery agent (the parent). This is the
 * delegation model, not a standalone browser-session architecture: the console creates/opens a
 * `network-recovery-expert` session (the recovery CASE) and gives it plain-language instructions. The agent
 * decides when on-device evidence is needed and calls the `scan_device_evidence` delegate tool; Central resolves
 * the tool's `target` against the case's authoritative device roster and routes each scan to the bound browser
 * edge worker(s) as delegated CHILD sessions. Device identity/authorization comes from a Central-minted binding
 * (redeemed from a one-time invite), never from a URL label — so the console lists only its own case's devices
 * and can target one device or fan out to all of them.
 */

const PARENT_SPEC_ID = 'network-recovery-expert';
const CHILD_SPEC_ID = 'device-scan-probe';
const TARGET_ALL = 'all';

interface InstructionPreset {
  id: string;
  label: string;
  detail: string;
  text: string;
}

const presets: InstructionPreset[] = [
  {
    id: 'lights',
    label: 'Check indicator lights',
    detail: 'Ask the on-site phone to read the router/ONT status lights',
    text: 'The network is down. Ask the on-site phone to check the router/modem status lights and report their colours, which are lit, and any that are blinking.'
  },
  {
    id: 'label',
    label: 'Scan model / serial label',
    detail: 'Delegate a label scan (barcode/QR if available)',
    text: 'We need the exact hardware to match it to line records. Ask the on-site phone to scan the router/modem model and serial-number label, including any barcode or QR code.'
  },
  {
    id: 'cabling',
    label: 'Inspect WAN / fiber cabling',
    detail: 'Check the WAN/DSL/fiber port and cabling area',
    text: 'Ask the on-site phone to inspect the WAN/DSL/fiber port and cabling on the back of the router/modem and report what is connected and how well it is seated.'
  }
];

interface ParentTurn {
  turnSeq: number;
  instruction: string;
  progress: string[];
  message: string;
  complete: boolean;
  failed: boolean;
  error?: string;
}

interface EvidenceRecord {
  turnSeq: number;
  taskLabel: string;
  progress: string[];
  message: string;
  kind: 'evidence' | 'text' | 'pending';
  status?: string;
  target?: string;
  source?: string;
  analysis?: FrameAnalysis;
  manifest?: EdgeDeviceManifest;
  complete: boolean;
  failed: boolean;
  error?: string;
}

/**
 * A live-or-terminal delegated scan child. One case can fan out to several devices, so the console tracks a child
 * per delegation and attributes it to a rostered device via the child's `currentWorkerId`.
 */
interface ChildView {
  childId: string;
  handle: SessionHandle;
  observe: AbortController;
  status: SessionStatus;
  workerId?: string;
  deviceRef?: string;
  deviceLabel?: string;
  manifest?: EdgeDeviceManifest;
  records: Map<number, EvidenceRecord>;
  lost: boolean;
}

interface ConsoleState {
  config: DemoConfig;
  centralUrl: string;
  tenantId: string;
  client?: AgentRuntimeClient;
  parent?: SessionHandle;
  caseId?: string;
  parentStatus: SessionStatus;
  connection: 'idle' | 'connecting' | 'connected' | 'error';
  parentTurns: Map<number, ParentTurn>;
  children: Map<string, ChildView>;
  // Terminal child ids the poller must not re-bind (a retry lists the failed child beside the fresh one).
  retiredChildIds: Set<string>;
  devices: CaseDeviceView[];
  invite?: PairingInvite;
  inviteLink?: string;
  mintingInvite: boolean;
  // Operator target selection: TARGET_ALL for fan-out, else a specific deviceRef.
  selectedTarget: string;
  lastScanInstruction?: string;
  starting: boolean;
  sending: boolean;
  instruction: string;
  error: string;
  settingsOpen: boolean;
  parentObserve?: AbortController;
  childPoll?: ReturnType<typeof setInterval>;
  devicePoll?: ReturnType<typeof setInterval>;
}

let root: HTMLElement;
let state: ConsoleState;
let renderScheduled = false;

export function mountConsole(mountRoot: HTMLElement, config: DemoConfig): void {
  root = mountRoot;
  state = {
    config,
    centralUrl: config.centralUrl,
    tenantId: config.tenantId,
    parentStatus: 'unknown',
    connection: 'idle',
    parentTurns: new Map(),
    children: new Map(),
    retiredChildIds: new Set(),
    devices: [],
    mintingInvite: false,
    selectedTarget: TARGET_ALL,
    starting: false,
    sending: false,
    instruction: '',
    error: '',
    settingsOpen: false,
    caseId: config.sessionId
  };
  render();
  void connect();
}

async function connect(): Promise<void> {
  state.connection = 'connecting';
  state.error = '';
  render();
  try {
    const client = new AgentRuntimeClient({ centralUrl: state.centralUrl, tenantId: state.tenantId });
    await client.connect();
    state.client = client;
    state.connection = 'connected';
    if (state.caseId) {
      await openParent(state.caseId);
    }
  } catch (error) {
    state.connection = 'error';
    state.error = errorMessage(error);
  }
  render();
}

/* ---------- parent (durable recovery agent = the case) ---------- */

async function startSession(): Promise<void> {
  if (!state.client || state.starting || state.parent) return;
  state.starting = true;
  state.error = '';
  render();
  try {
    const result = await state.client.sessions.start({
      agent: PARENT_SPEC_ID,
      displayName: 'Remote network recovery',
      workspace: { source: 'empty' }
    });
    bindParent(result.session);
  } catch (error) {
    state.error = errorMessage(error);
  } finally {
    state.starting = false;
    render();
  }
}

async function openParent(sessionId: string): Promise<void> {
  if (!state.client) return;
  const session = await state.client.sessions.open(sessionId);
  bindParent(session);
  try {
    await session.resume();
  } catch {
    /* a fresh page open of a running session does not need resume; ignore */
  }
}

function bindParent(session: SessionHandle): void {
  state.parent = session;
  state.caseId = session.id;
  state.parentStatus = 'created';
  syncSessionUrl();
  observeParent(session);
  startChildPolling();
  startDevicePolling();
}

function observeParent(session: SessionHandle): void {
  state.parentObserve?.abort();
  const controller = new AbortController();
  state.parentObserve = controller;
  void (async () => {
    try {
      for await (const event of session.observe({ signal: controller.signal })) {
        applyParentEvent(event);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        state.error = errorMessage(error);
        scheduleRender();
      }
    }
  })();
}

/**
 * Central only accepts a turn once the parent case has a worker attached (status `running`); handing it an
 * instruction while it is still `queued`/`created`/`starting`/`paused` is accepted-then-failed with
 * `no_current_worker`. So the console derives one gate for the whole instruction surface and enables input only when
 * the agent is genuinely ready to route a scan.
 */
function instructionGate(): InstructionGate {
  return computeInstructionGate({
    connected: state.connection === 'connected',
    hasParent: Boolean(state.parent),
    parentStatus: state.parentStatus,
    sending: state.sending
  });
}

function canInstruct(): boolean {
  return instructionGate() === 'ready';
}

async function sendInstruction(text: string, targetOverride?: ScanTarget): Promise<void> {
  const message = text.trim();
  if (!message) return;
  // Do not silently start a session or send into a worker-less parent: both surface as an immediate
  // `no_current_worker` turn failure. Require an explicit, ready parent first and say why when it is not.
  if (!state.parent) {
    state.error = 'Start a recovery session before sending instructions.';
    render();
    return;
  }
  if (!canInstruct()) {
    state.error = `The recovery agent is ${esc(state.parentStatus)} and has no worker attached yet — waiting for parent capacity. Instructions are enabled once the session is running.`;
    render();
    return;
  }
  state.error = '';
  state.sending = true;
  state.lastScanInstruction = message;
  render();
  try {
    // Send the operator's device-routing intent as the turn's structured `delegationTarget` — trusted control
    // metadata, NOT text in the instruction. Central binds it to this accepted turn and enforces it when the parent
    // agent's `scan_device_evidence` delegate fires: the agent may echo it but cannot widen or redirect it. A retry
    // passes an explicit failed-only target override so it never re-scans a device that already returned.
    await state.parent.send({ message, delegationTarget: targetOverride ?? selectedTargetSpec() });
    state.instruction = '';
  } catch (error) {
    state.error = errorMessage(error);
  } finally {
    state.sending = false;
    render();
  }
}

function selectedTargetSpec(): ScanTarget {
  return state.selectedTarget === TARGET_ALL ? { scope: 'all' } : { deviceRef: state.selectedTarget };
}

/**
 * Retry after one or more devices were lost mid-scan. The retry re-targets ONLY the devices whose scan was lost —
 * never a sibling that already returned evidence — by naming their `deviceRef`s explicitly (Central opens a FRESH
 * delegated child per target; the failed delegations are terminal, so they are never reused). The terminal lost
 * child views are dropped first so the fresh scan supersedes them and the "scan could not reach its device" banner
 * clears. With no lost devices this falls back to the operator's current selection.
 */
async function retryScan(): Promise<void> {
  const instruction = state.lastScanInstruction ?? presets[0]?.text;
  if (!instruction) return;
  const lostViews = [...state.children.values()].filter((view) => view.lost);
  const failedRefs = [...new Set(lostViews.map((view) => view.deviceRef).filter((ref): ref is string => Boolean(ref)))];
  for (const view of lostViews) state.children.delete(view.childId);
  const target: ScanTarget | undefined =
    failedRefs.length === 0
      ? undefined
      : failedRefs.length === 1
        ? { deviceRef: failedRefs[0] }
        : { deviceRefs: failedRefs };
  await sendInstruction(instruction, target);
}

function applyParentEvent(event: SessionEvent): void {
  switch (event.type) {
    case 'status':
      state.parentStatus = event.status;
      break;
    case 'user.message': {
      const turn = parentTurnFor(event.turnSeq);
      if (!turn.instruction) turn.instruction = event.text.trim();
      break;
    }
    case 'agent.progress':
      parentTurnFor(event.turnSeq).progress.push(event.message);
      break;
    case 'assistant.delta':
      parentTurnFor(event.turnSeq).message += event.text;
      break;
    case 'turn.completed': {
      const turn = parentTurnFor(event.turnSeq);
      if (event.result.message) turn.message = event.result.message;
      turn.complete = true;
      break;
    }
    case 'turn.failed': {
      const turn = parentTurnFor(event.turnSeq);
      turn.failed = true;
      turn.complete = true;
      turn.error = event.error.message;
      break;
    }
    default:
      break;
  }
  scheduleRender();
}

/* ---------- case device roster (Central-authoritative, pre-delegation) ---------- */

function startDevicePolling(): void {
  if (state.devicePoll) return;
  state.devicePoll = setInterval(() => {
    void refreshDevices();
  }, 2000);
  void refreshDevices();
}

/**
 * Source of truth for "which devices are paired to this case" — a tenant- and case-scoped control-plane read, NOT
 * inferred from child sessions or scraped from worker labels. Central returns only this case's authorized roster.
 */
async function refreshDevices(): Promise<void> {
  if (!state.client || !state.caseId) return;
  try {
    state.devices = await state.client.cases.listDevices(state.caseId);
    // If the selected device left the roster, fall back to fan-out so a stale ref is never targeted.
    if (state.selectedTarget !== TARGET_ALL && !state.devices.some((d) => d.deviceRef === state.selectedTarget)) {
      state.selectedTarget = TARGET_ALL;
    }
    scheduleRender();
  } catch {
    /* transient read failure — keep the last known roster, next tick retries */
  }
}

function deviceFor(deviceRef: string | undefined): CaseDeviceView | undefined {
  if (!deviceRef) return undefined;
  return state.devices.find((device) => device.deviceRef === deviceRef);
}

function deviceForWorker(workerId: string | undefined): CaseDeviceView | undefined {
  if (!workerId) return undefined;
  return state.devices.find((device) => device.workerId === workerId);
}

/* ---------- pairing invite (one-time, Central-minted) ---------- */

async function createInvite(): Promise<void> {
  if (!state.client || !state.caseId || state.mintingInvite) return;
  state.mintingInvite = true;
  state.error = '';
  render();
  try {
    const invite = await state.client.cases.createPairingInvite(state.caseId);
    state.invite = invite;
    state.inviteLink = buildEdgeInviteLink({ centralUrl: state.centralUrl, tenantId: state.tenantId, invite });
  } catch (error) {
    state.error = errorMessage(error);
  } finally {
    state.mintingInvite = false;
    render();
  }
}

/* ---------- children (delegated scan sessions) ---------- */

function startChildPolling(): void {
  if (state.childPoll || !state.client) return;
  state.childPoll = setInterval(() => {
    void discoverChildren();
  }, 1500);
  void discoverChildren();
}

let childDiscoveryInFlight: Promise<void> | undefined;

async function discoverChildren(): Promise<void> {
  if (childDiscoveryInFlight) {
    return childDiscoveryInFlight;
  }
  childDiscoveryInFlight = discoverChildrenOnce().finally(() => {
    childDiscoveryInFlight = undefined;
  });
  return childDiscoveryInFlight;
}

async function discoverChildrenOnce(): Promise<void> {
  const client = state.client;
  const caseId = state.caseId;
  if (!client || !caseId) return;
  let sessions: SessionSummary[];
  try {
    sessions = await client.sessions.list();
  } catch {
    return;
  }
  if (client !== state.client || caseId !== state.caseId) return;
  for (const summary of sessions) {
    if (summary.parentSessionId !== caseId || summary.agentSpecId !== CHILD_SPEC_ID) continue;
    if (state.retiredChildIds.has(summary.sessionId)) continue;
    const existing = state.children.get(summary.sessionId);
    if (existing) {
      // Refresh live attribution: the child's assigned worker maps to a rostered device.
      existing.status = summary.status;
      if (summary.currentWorkerId) existing.workerId = summary.currentWorkerId;
      const device = deviceForWorker(existing.workerId);
      if (device) {
        existing.deviceRef = device.deviceRef;
        existing.deviceLabel = device.deviceLabel;
      }
      continue;
    }
    try {
      const handle = await client.sessions.open(summary.sessionId);
      if (client !== state.client || caseId !== state.caseId) return;
      const device = deviceForWorker(summary.currentWorkerId);
      const view: ChildView = {
        childId: handle.id,
        handle,
        observe: new AbortController(),
        status: summary.status,
        workerId: summary.currentWorkerId,
        deviceRef: device?.deviceRef,
        deviceLabel: device?.deviceLabel,
        records: new Map(),
        lost: false
      };
      state.children.set(view.childId, view);
      observeChild(view);
      scheduleRender();
    } catch (error) {
      state.error = errorMessage(error);
    }
  }
}

function observeChild(view: ChildView): void {
  void (async () => {
    try {
      for await (const event of view.handle.observe({ signal: view.observe.signal })) {
        applyChildEvent(view, event);
      }
    } catch (error) {
      if (!view.observe.signal.aborted) {
        state.error = errorMessage(error);
        scheduleRender();
      }
    }
  })();
}

function applyChildEvent(view: ChildView, event: SessionEvent): void {
  switch (event.type) {
    case 'status':
      view.status = event.status;
      if (isTerminalChildStatus(event.status)) handleChildLost(view);
      break;
    case 'user.message': {
      const record = recordFor(view, event.turnSeq);
      record.taskLabel = record.taskLabel || labelForTaskMessage(event.text);
      break;
    }
    case 'agent.progress':
      recordFor(view, event.turnSeq).progress.push(event.message);
      break;
    case 'assistant.delta':
      recordFor(view, event.turnSeq).message += event.text;
      break;
    case 'turn.completed': {
      const record = recordFor(view, event.turnSeq);
      if (event.result.message) record.message = event.result.message;
      applyStructuredOutput(view, record, event.result.output);
      record.complete = true;
      break;
    }
    case 'turn.failed': {
      const record = recordFor(view, event.turnSeq);
      record.failed = true;
      record.complete = true;
      record.error = event.error.message;
      break;
    }
    default:
      break;
  }
  scheduleRender();
}

function applyStructuredOutput(view: ChildView, record: EvidenceRecord, output: unknown): void {
  if (!isRecord(output)) {
    record.kind = record.kind === 'pending' ? 'text' : record.kind;
    return;
  }
  if (output.kind === 'device-manifest' && isRecord(output.manifest)) {
    record.manifest = output.manifest as unknown as EdgeDeviceManifest;
    view.manifest = record.manifest;
    record.kind = 'text';
    return;
  }
  if (output.kind === 'device-evidence') {
    record.kind = 'evidence';
    record.status = typeof output.status === 'string' ? output.status : undefined;
    record.target = typeof output.target === 'string' ? output.target : undefined;
    record.source = typeof output.source === 'string' ? output.source : undefined;
    if (isRecord(output.analysis)) record.analysis = output.analysis as unknown as FrameAnalysis;
    return;
  }
  record.kind = 'text';
}

/**
 * A delegated child terminated because its paired browser worker was lost (tab closed, iOS suspended, transport
 * dropped) before the scan returned. Central fails the child rather than silently re-routing to an unrelated tab,
 * so the console makes it explicit: mark the child's in-flight scans failed, flag it lost, retire it so the poller
 * won't re-observe it, and stop observing. A retry opens a fresh delegation + child against the same target.
 */
function handleChildLost(view: ChildView): void {
  for (const record of view.records.values()) {
    if (!record.complete) {
      record.failed = true;
      record.complete = true;
      record.error = record.error ?? 'The paired device dropped before the scan returned evidence.';
    }
  }
  view.lost = true;
  state.retiredChildIds.add(view.childId);
  view.observe.abort();
}

/* ---------- rollup ---------- */

interface Diagnosis {
  captures: number;
  avgQuality?: number;
  issues: FrameFinding[];
  warnings: FrameFinding[];
}

function allRecords(): EvidenceRecord[] {
  return [...state.children.values()].flatMap((view) => [...view.records.values()]);
}

function rollup(): Diagnosis {
  const analyses = allRecords().filter((r) => r.analysis).map((r) => r.analysis!);
  const issues: FrameFinding[] = [];
  const warnings: FrameFinding[] = [];
  for (const analysis of analyses) {
    for (const finding of analysis.findings) {
      if (finding.severity === 'issue') issues.push(finding);
      else if (finding.severity === 'warn') warnings.push(finding);
    }
  }
  const avgQuality = analyses.length ? analyses.reduce((sum, a) => sum + a.qualityScore, 0) / analyses.length : undefined;
  return { captures: analyses.length, avgQuality, issues, warnings };
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
  const diag = rollup();
  const records = allRecords().sort((a, b) => b.turnSeq - a.turnSeq);
  const parentTurns = [...state.parentTurns.values()].sort((a, b) => b.turnSeq - a.turnSeq);
  root.innerHTML = `
    <div class="shell console">
      <header class="topbar">
        <div class="brand">
          <div class="mark">◇</div>
          <div>
            <div class="brandName">Network Recovery Console</div>
            <div class="brandSub">Durable recovery agent · Operator console</div>
          </div>
        </div>
        <div class="topActions">
          ${state.caseId ? `<span class="pill casePill" title="Recovery case (parent session)">Case ${esc(shortId(state.caseId))}</span>` : ''}
          ${connectionPill()}
          <button class="ghostBtn" id="toggleSettings">Connection</button>
        </div>
      </header>

      ${state.settingsOpen ? settingsPanel() : ''}
      ${state.error ? `<div class="banner error">${esc(state.error)}</div>` : ''}
      ${routingBanner()}
      ${queueHint()}

      <main class="grid">
        <section class="col">
          <div class="card sessionCard">
            <div class="cardHead"><h2>Recovery session</h2>${statusPill(state.parentStatus)}</div>
            <div class="kv"><span>Case (parent)</span><code>${esc(shortId(state.caseId))}</code></div>
            <div class="kv"><span>Agent spec</span><code>${PARENT_SPEC_ID}</code></div>
            <div class="kv"><span>Paired devices</span><code>${state.devices.length}</code></div>
            <p class="muted">The cloud agent is durable. When it needs on-device evidence it delegates a
              <code>${CHILD_SPEC_ID}</code> scan step, routed only to the case's paired browser device(s) — the phone worker is not a daemon.</p>
            ${state.parent ? '' : `<div class="row"><button class="primaryBtn" id="startBtn" ${state.connection === 'connected' && !state.starting ? '' : 'disabled'}>${state.starting ? 'Starting…' : 'Start recovery session'}</button></div>`}
          </div>

          ${pairCard()}
          ${instructCard()}
        </section>

        <section class="col wide">
          ${deviceRosterCard()}
          ${diagnosisCard(diag)}
          ${parentLogCard(parentTurns)}
          <div class="card">
            <div class="cardHead"><h2>On-device evidence</h2><span class="count">${records.length}</span></div>
            ${records.length ? records.map(evidenceView).join('') : '<div class="empty">No delegated scans yet. Instruct the agent to check the device.</div>'}
          </div>
        </section>
      </main>
      <footer class="foot">Raw camera frames stay on the device — only structured observations are returned. Browser workers suspend when the tab closes.</footer>
    </div>`;
  wireConsole();
}

function pairCard(): string {
  const canPair = Boolean(state.parent);
  const link = state.inviteLink;
  const expiry = state.invite ? new Date(state.invite.expiresAt).toLocaleTimeString() : undefined;
  const caseLine = state.caseId
    ? `<div class="kv"><span>Pairing into case</span><code>${esc(shortId(state.caseId))}</code></div>`
    : '';
  return `
    <div class="card pairCard">
      <div class="cardHead"><h2>Pair an edge device</h2>${pairStatusPill()}</div>
      ${caseLine}
      <p class="muted">Mint a <b>one-time invite</b> for <b>this case</b>, then open its link on the phone that will
        scan the hardware (needs https or localhost for the camera). The device redeems the invite once into a durable
        Central binding; the invite is not a routing secret and never authorizes on its own. <b>Every device for this
        recovery must be paired from this same console/case</b> — an invite minted from a different console binds the
        phone to a different case and it will not appear here. Mint another invite for each additional device.</p>
      <div class="row">
        <button class="primaryBtn" id="mintInvite" ${canPair && !state.mintingInvite ? '' : 'disabled'}>${state.mintingInvite ? 'Minting…' : 'Create pairing invite'}</button>
      </div>
      ${link
        ? `<div class="linkRow">
             <input id="edgeLink" readonly value="${esc(link)}" />
             <button class="secondaryBtn" id="copyLink">Copy</button>
           </div>
           <div class="qrHint">One-time invite for case <code>${esc(shortId(state.caseId))}</code>${expiry ? ` · expires ${esc(expiry)}` : ''}. The secret rides only in the URL fragment (<code>#pair=…</code>) and is stripped on the phone after redemption. Same machine? Open the link in a second tab to simulate a phone.</div>`
        : `<div class="qrHint">${canPair ? 'No invite yet — create one to pair a device.' : 'Start a recovery session first, then create a pairing invite.'}</div>`}
    </div>`;
}

function instructCard(): string {
  const gate = instructionGate();
  const ready = gate === 'ready';
  const hint = ready
    ? 'Instructions go to the durable agent. It decides when to delegate a scan step, routed to the selected device — or fanned out to every paired device.'
    : gate === 'disconnected'
      ? 'Reconnect to Central to instruct the agent.'
      : gate === 'no-session'
        ? 'Start a recovery session first — instructions enable once the agent is running.'
        : `Waiting for parent capacity — the agent is ${esc(state.parentStatus)} with no worker attached. Instructions enable once the session is running.`;
  const waitingPill = !ready && state.parent ? '<span class="pill st-idle">waiting for capacity</span>' : '';
  return `
    <div class="card taskCard">
      <div class="cardHead"><h2>Instruct the agent</h2>${waitingPill}</div>
      ${targetSelector()}
      <div class="taskList">
        ${presets.map(presetButton).join('')}
      </div>
      <div class="instrRow">
        <input id="instruction" placeholder="Type an instruction for the recovery agent…" value="${esc(state.instruction)}" ${ready ? '' : 'disabled'} />
        <button class="secondaryBtn" id="sendBtn" ${ready ? '' : 'disabled'}>${state.sending ? 'Sending…' : 'Send'}</button>
      </div>
      <p class="muted small">${esc(hint)}</p>
    </div>`;
}

function targetSelector(): string {
  const options = [`<option value="${TARGET_ALL}" ${state.selectedTarget === TARGET_ALL ? 'selected' : ''}>All paired devices (${state.devices.length})</option>`];
  for (const device of state.devices) {
    const status = device.online ? (device.busy ? 'busy' : 'ready') : 'offline';
    options.push(
      `<option value="${esc(device.deviceRef)}" ${state.selectedTarget === device.deviceRef ? 'selected' : ''}>${esc(device.deviceLabel)} · ${esc(shortId(device.deviceRef))} · ${status}</option>`
    );
  }
  return `
    <label class="targetSelect">
      <span>Scan target</span>
      <select id="targetSelect" ${state.parent ? '' : 'disabled'}>${options.join('')}</select>
    </label>`;
}

function routingBanner(): string {
  if (state.connection !== 'connected') return '';
  const lost = [...state.children.values()].filter((view) => view.lost);
  if (!lost.length) return '';
  const anyStillOnline = lost.some((view) => deviceFor(view.deviceRef)?.online);
  const route = computeScanRoute({ scanActive: true, childTerminated: true, deviceOnline: anyStillOnline });
  if (route !== 'device-lost') return '';
  const names = lost.map((view) => esc(view.deviceLabel ?? shortId(view.deviceRef) ?? 'a paired device')).join(', ');
  return `<div class="banner error routingLost">
    <div><b>A scan could not reach its device.</b> The browser worker for ${names} dropped — tab closed,
      backgrounded, or network lost — before it returned evidence, so Central failed the delegated scan instead of
      silently routing it to another device. Bring the phone back to the foreground so it reconnects (it re-registers
      with its stored binding — no new invite needed), then retry: the new scan re-targets only the failed device(s),
      never a sibling that already returned evidence.</div>
    <button class="primaryBtn" id="retryScan" ${state.sending || !canInstruct() ? 'disabled' : ''}>${state.sending ? 'Retrying…' : 'Retry scan'}</button>
  </div>`;
}

function queueHint(): string {
  if (state.connection !== 'connected' || !state.parent) return '';
  const gate = instructionGate();
  if (gate === 'waiting-capacity') {
    if (state.parentStatus === 'queued') {
      return `<div class="banner warn"><b>Waiting for parent capacity.</b> The recovery session is <b>queued</b> — waiting for a <code>${PARENT_SPEC_ID}</code> Copilot worker. The default local <code>poc-docker-copilot</code> pool creates one session-pinned worker per queued case; a manually started sidecar or the offline scripted harness has fixed capacity. Instructions stay disabled until this case is running.</div>`;
    }
    return `<div class="banner warn"><b>Waiting for parent capacity.</b> The recovery agent is <b>${esc(state.parentStatus)}</b> and has no worker attached yet. Instructions stay disabled until the session is <b>running</b>, so a turn is never sent into a <code>no_current_worker</code> failure.</div>`;
  }
  const pending = [...state.children.values()].some(
    (view) => !view.lost && view.status === 'queued' && !deviceFor(view.deviceRef)?.online
  );
  if (pending) {
    return '<div class="banner warn">A scan was delegated but its target device is offline. It routes only to the paired device — open the pairing link on the phone. Scans never fall back to an unrelated device.</div>';
  }
  return '';
}

function connectionPill(): string {
  const map: Record<ConsoleState['connection'], string> = {
    idle: 'idle',
    connecting: 'connecting…',
    connected: 'connected',
    error: 'error'
  };
  return `<span class="pill conn-${state.connection}">${map[state.connection]}</span>`;
}

function statusPill(status: SessionStatus): string {
  return `<span class="pill st-${esc(status)}">${esc(status)}</span>`;
}

function pairStatusPill(): string {
  const online = state.devices.filter((device) => device.online).length;
  if (online > 0) return `<span class="pill st-done">${online} online</span>`;
  if (state.devices.length) return `<span class="pill st-failed">${state.devices.length} offline</span>`;
  return '<span class="pill st-idle">no devices</span>';
}

function settingsPanel(): string {
  return `
    <div class="card settings">
      <div class="cardHead"><h2>Runtime connection</h2></div>
      <label>Central URL<input id="centralUrl" value="${esc(state.centralUrl)}" /></label>
      <label>Tenant<input id="tenantId" value="${esc(state.tenantId)}" /></label>
      <div class="row"><button class="primaryBtn" id="saveSettings">Save &amp; reconnect</button></div>
      <p class="muted small">Saving reconnects and starts a fresh case.</p>
    </div>`;
}

function presetButton(def: InstructionPreset): string {
  const disabled = canInstruct() ? '' : 'disabled';
  return `
    <button class="taskBtn" data-preset="${esc(def.id)}" ${disabled}>
      <div class="taskBtnTitle">${esc(def.label)}</div>
      <div class="taskBtnDetail">${esc(def.detail)}</div>
    </button>`;
}

function parentLogCard(turns: ParentTurn[]): string {
  if (!turns.length) return '';
  return `
    <div class="card">
      <div class="cardHead"><h2>Agent diagnosis log</h2><span class="count">${turns.length}</span></div>
      ${turns.map(parentTurnView).join('')}
    </div>`;
}

function parentTurnView(turn: ParentTurn): string {
  const head = `<div class="evHead"><div class="evTitle">#${turn.turnSeq} · ${esc(turn.instruction || 'Instruction')}</div>${turn.failed ? '<span class="pill st-failed">failed</span>' : turn.complete ? '<span class="pill st-done">done</span>' : '<span class="pill st-running">working</span>'}</div>`;
  if (turn.failed) return `<div class="evidence failed">${head}<div class="evErr">${esc(turn.error ?? 'Turn failed')}</div></div>`;
  const progress = turn.progress.length ? `<div class="progress">${turn.progress.map((p) => `<div class="progLine">${esc(p)}</div>`).join('')}</div>` : '';
  return `<div class="evidence">${head}${progress}${turn.message ? `<div class="evMsg">${esc(turn.message)}</div>` : '<div class="muted small">Working…</div>'}</div>`;
}

function deviceStagesFor(device: CaseDeviceView, child: ChildView | undefined): DeviceStage[] {
  const records = child ? [...child.records.values()] : [];
  return computeDeviceStages({
    online: device.online,
    busy: device.busy,
    assigned: Boolean(child) && !child!.lost,
    childRunning: child?.status === 'running',
    hasIncompleteRecord: records.some((record) => !record.complete),
    hasEvidence: records.some((record) => record.complete && Boolean(record.analysis || record.manifest))
  });
}

function stageStepper(stages: DeviceStage[]): string {
  return `<div class="stageRow">${stages
    .map((stage) => `<span class="stage st-${stage.state}"><span class="stageDot"></span>${esc(stage.label)}</span>`)
    .join('')}</div>`;
}

function liveChildForDevice(deviceRef: string): ChildView | undefined {
  const views = [...state.children.values()].filter((view) => view.deviceRef === deviceRef);
  return views.find((view) => !view.lost) ?? views[views.length - 1];
}

function deviceRosterCard(): string {
  if (!state.devices.length) {
    return `
      <div class="card deviceCard">
        <div class="cardHead"><h2>Paired edge devices</h2><span class="pill st-idle">none</span></div>
        <div class="empty small">No device is paired to this case yet. Create a pairing invite and open its link on the phone; each device appears here as soon as it joins — before any scan is delegated.</div>
      </div>`;
  }
  return `
    <div class="card deviceCard">
      <div class="cardHead"><h2>Paired edge devices</h2><span class="count">${state.devices.length}</span></div>
      ${state.devices.map(deviceRow).join('')}
    </div>`;
}

function deviceRow(device: CaseDeviceView): string {
  const child = liveChildForDevice(device.deviceRef);
  const availability = device.online
    ? device.busy
      ? '<span class="pill st-running">online · busy</span>'
      : '<span class="pill st-done">online · ready</span>'
    : '<span class="pill st-failed">offline</span>';
  const heartbeat = device.lastHeartbeatAt ? new Date(device.lastHeartbeatAt).toLocaleTimeString() : '—';
  const manifest = child?.manifest;
  const detectors = manifest?.detectors?.length ? manifest.detectors.map((d) => d.displayName).join(', ') : undefined;
  const childLine = child
    ? child.lost
      ? '<span class="pill st-failed">scan lost</span>'
      : `<span class="pill st-${esc(child.status)}">child ${esc(shortId(child.childId))} · ${esc(child.status)}</span>`
    : '<span class="pill st-idle">no scan assigned</span>';
  return `
    <div class="deviceRow">
      <div class="deviceRowHead">
        <div class="deviceName">${esc(device.deviceLabel)}</div>
        ${availability}
      </div>
      ${stageStepper(deviceStagesFor(device, child))}
      <div class="deviceGrid">
        <div class="kv"><span>Device ref</span><code>${esc(shortId(device.deviceRef))}</code></div>
        <div class="kv"><span>Worker</span><code>${esc(shortId(device.workerId))}</code></div>
        <div class="kv"><span>Assignment</span>${childLine}</div>
        <div class="kv"><span>Last heartbeat</span><code>${esc(heartbeat)}</code></div>
        ${manifest ? `<div class="kv"><span>Capture scope</span><code>${manifest.captureSources.length ? esc(manifest.captureSources.join(', ')) : 'none (fallback only)'}</code></div>` : ''}
        ${detectors ? `<div class="kv"><span>Detectors</span><code>${esc(detectors)}</code></div>` : ''}
        ${manifest ? `<div class="kv"><span>Privacy</span><code>${esc(manifest.privacy.returns)}</code></div>` : ''}
      </div>
      ${manifest ? '' : '<p class="muted small">Device is joined and reachable. Capability manifest and observations arrive once the agent delegates a scan.</p>'}
    </div>`;
}

function diagnosisCard(diag: Diagnosis): string {
  if (!diag.captures) return '';
  const quality = diag.avgQuality !== undefined ? fmtPct(diag.avgQuality) : '—';
  const verdict = diag.issues.length ? 'Action needed' : diag.warnings.length ? 'Usable with caveats' : 'Healthy capture conditions';
  const verdictClass = diag.issues.length ? 'sev-issue' : diag.warnings.length ? 'sev-warn' : 'sev-ok';
  const top = [...diag.issues, ...diag.warnings].slice(0, 4);
  return `
    <div class="card diagCard">
      <div class="cardHead"><h2>Rolled-up evidence</h2><span class="badge ${verdictClass}">${esc(verdict)}</span></div>
      <div class="diagStats">
        <div class="stat"><div class="statNum">${diag.captures}</div><div class="statLbl">captures</div></div>
        <div class="stat"><div class="statNum">${quality}</div><div class="statLbl">avg quality</div></div>
        <div class="stat"><div class="statNum">${diag.issues.length}</div><div class="statLbl">issues</div></div>
        <div class="stat"><div class="statNum">${diag.warnings.length}</div><div class="statLbl">warnings</div></div>
      </div>
      ${top.length ? `<ul class="findingList">${top.map(findingView).join('')}</ul>` : '<div class="muted small">No issues or warnings across captures.</div>'}
    </div>`;
}

function evidenceView(record: EvidenceRecord): string {
  const head = `
    <div class="evHead">
      <div class="evTitle">#${record.turnSeq} · ${esc(record.taskLabel || 'Capture')}</div>
      ${evidenceStatusPill(record)}
    </div>`;
  if (record.failed) {
    return `<div class="evidence failed">${head}<div class="evErr">${esc(record.error ?? 'Turn failed')}</div></div>`;
  }
  if (record.kind === 'evidence' && record.analysis) {
    return `<div class="evidence">${head}${analysisView(record)}</div>`;
  }
  if (record.kind === 'evidence' && !record.analysis) {
    return `<div class="evidence">${head}<div class="evMsg">${esc(record.message)}</div>${record.status ? `<div class="muted small">status: ${esc(record.status)}</div>` : ''}</div>`;
  }
  const progress = record.progress.length ? `<div class="progress">${record.progress.map((p) => `<div class="progLine">${esc(p)}</div>`).join('')}</div>` : '';
  return `<div class="evidence">${head}${progress}${record.message ? `<div class="evMsg">${esc(record.message)}</div>` : '<div class="muted small">Waiting for the edge worker…</div>'}</div>`;
}

function analysisView(record: EvidenceRecord): string {
  const a = record.analysis!;
  const s = a.signals;
  const rows: [string, string][] = [
    ['Quality', fmtPct(a.qualityScore)],
    ['Brightness', `${fmtPct(s.brightness.normalized)} (luma ${s.brightness.meanLuma.toFixed(0)})`],
    ['Focus', `${fmtPct(s.sharpness.focusScore)} (lapVar ${s.sharpness.laplacianVariance.toFixed(0)})`],
    ['Contrast', fmtPct(s.contrast.normalized)],
    ['Colour', `${s.colorBalance.temperatureLabel} · ${s.colorBalance.dominantCast} · ~${s.colorBalance.estimatedKelvin}K`],
    ['Glare', `${fmtPct(s.glare.brightPixelPct)} bright · ${fmtPct(s.glare.hotspotPct)} hotspot`],
    ['Exposure', `${fmtPct(s.exposure.clippedHighlightsPct)} hi · ${fmtPct(s.exposure.clippedShadowsPct)} lo`]
  ];
  return `
    <div class="evMsg">${esc(a.summary)} <b>${esc(a.recommendation)}</b></div>
    <div class="signalGrid">
      ${rows.map(([k, v]) => `<div class="sigCell"><div class="sigKey">${esc(k)}</div><div class="sigVal">${esc(v)}</div></div>`).join('')}
    </div>
    ${a.findings.length ? `<ul class="findingList">${a.findings.map(findingView).join('')}</ul>` : ''}`;
}

function findingView(finding: FrameFinding): string {
  return `<li class="finding ${severityClass(finding.severity)}"><span class="dot"></span><b>${esc(finding.label)}</b> — ${esc(finding.detail)}</li>`;
}

function evidenceStatusPill(record: EvidenceRecord): string {
  if (record.failed) return '<span class="pill st-failed">failed</span>';
  if (!record.complete) return '<span class="pill st-running">running</span>';
  if (record.status && record.status !== 'captured') return `<span class="pill st-idle">${esc(record.status)}</span>`;
  return '<span class="pill st-done">complete</span>';
}

/* ---------- dom glue ---------- */

function wireConsole(): void {
  root.querySelector('#toggleSettings')?.addEventListener('click', () => {
    state.settingsOpen = !state.settingsOpen;
    render();
  });
  root.querySelector('#saveSettings')?.addEventListener('click', () => {
    const central = root.querySelector<HTMLInputElement>('#centralUrl')?.value.trim();
    const tenant = root.querySelector<HTMLInputElement>('#tenantId')?.value.trim();
    if (central) { state.centralUrl = central; persist('centralUrl', central); }
    if (tenant) { state.tenantId = tenant; persist('tenantId', tenant); }
    resetSession();
    state.settingsOpen = false;
    void connect();
  });
  root.querySelector('#startBtn')?.addEventListener('click', () => void startSession());
  root.querySelector('#mintInvite')?.addEventListener('click', () => void createInvite());
  root.querySelector('#retryScan')?.addEventListener('click', () => void retryScan());
  root.querySelector('#targetSelect')?.addEventListener('change', (event) => {
    state.selectedTarget = (event.target as HTMLSelectElement).value;
  });
  root.querySelector('#sendBtn')?.addEventListener('click', () => {
    const input = root.querySelector<HTMLInputElement>('#instruction');
    void sendInstruction(input?.value ?? state.instruction);
  });
  root.querySelector('#instruction')?.addEventListener('input', (event) => {
    state.instruction = (event.target as HTMLInputElement).value;
  });
  root.querySelector('#instruction')?.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') {
      event.preventDefault();
      const input = event.target as HTMLInputElement;
      void sendInstruction(input.value);
    }
  });
  root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const preset = presets.find((p) => p.id === button.dataset.preset);
      if (preset) void sendInstruction(preset.text);
    });
  });
  root.querySelector('#copyLink')?.addEventListener('click', () => {
    const input = root.querySelector<HTMLInputElement>('#edgeLink');
    if (input) {
      input.select();
      void navigator.clipboard?.writeText(input.value).catch(() => undefined);
    }
  });
}

/* ---------- helpers ---------- */

function parentTurnFor(turnSeq: number): ParentTurn {
  let turn = state.parentTurns.get(turnSeq);
  if (!turn) {
    turn = { turnSeq, instruction: '', progress: [], message: '', complete: false, failed: false };
    state.parentTurns.set(turnSeq, turn);
  }
  return turn;
}

function recordFor(view: ChildView, turnSeq: number): EvidenceRecord {
  let record = view.records.get(turnSeq);
  if (!record) {
    record = { turnSeq, taskLabel: '', progress: [], message: '', kind: 'pending', complete: false, failed: false };
    view.records.set(turnSeq, record);
  }
  return record;
}

function labelForTaskMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.task === 'manifest') return 'Probe device capability';
    if (parsed.task === 'capture' && typeof parsed.target === 'string') return `Capture · ${parsed.target}`;
  } catch {
    /* not JSON */
  }
  return 'Capture';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resetSession(): void {
  state.parentObserve?.abort();
  for (const view of state.children.values()) view.observe.abort();
  if (state.childPoll) clearInterval(state.childPoll);
  if (state.devicePoll) clearInterval(state.devicePoll);
  state.parent = undefined;
  state.caseId = undefined;
  state.children = new Map();
  state.parentTurns = new Map();
  state.retiredChildIds = new Set();
  state.devices = [];
  state.invite = undefined;
  state.inviteLink = undefined;
  state.selectedTarget = TARGET_ALL;
  state.lastScanInstruction = undefined;
  state.parentStatus = 'unknown';
  state.childPoll = undefined;
  state.devicePoll = undefined;
}

function syncSessionUrl(): void {
  if (!state.caseId) return;
  const url = new URL(location.href);
  url.searchParams.set('role', 'console');
  url.searchParams.set('session', state.caseId);
  history.replaceState(null, '', url.toString());
}
