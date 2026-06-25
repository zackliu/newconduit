import { AgentRuntimeClient, type AgentTurnEvent, type SdkRuntimeEvent, type SdkSubscription, type SessionHandle, type SessionSummary } from '@agent-runtime-sidecar/sdk';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  turnSeq?: number;
}

interface TraceEvent {
  id: string;
  turnSeq: number;
  label: string;
  detail?: string;
}

interface RuntimeStatus {
  workerPools: WorkerPoolSummary[];
  hostPoolInstances: HostPoolInstanceSummary[];
  workers: WorkerSummary[];
}

interface WorkerPoolSummary {
  poolId: string;
  hostPoolControllerClass: string;
  sidecarClass: string;
  labels: Record<string, string>;
  capacityPerWorker: number;
  scalePolicy: {
    scaleOutMaxPendingPerTick: number;
    scaleInIdleMs: number;
  };
}

interface HostPoolInstanceSummary {
  instanceId: string;
  poolId: string;
  state: string;
  containerId?: string;
  workerId?: string;
  idleSince?: string;
  updatedAt: string;
}

interface WorkerSummary {
  workerId: string;
  sidecarClass: string;
  labels: Record<string, string>;
  description?: Record<string, string>;
  capacity: number;
  allocatable: number;
  conditions: string[];
  lifecycleState: string;
  currentSessionCount: number;
  updatedAt: string;
}

interface AgentSpecOption {
  agentSpecId: string;
  title: string;
  sidecarClass: string;
  workerSelector: Record<string, string>;
  provider: string;
  workspaceClass: string;
}

const AGENT_SPECS: AgentSpecOption[] = [
  {
    agentSpecId: 'copilot-poc',
    title: 'Copilot process-wrapper agent',
    sidecarClass: 'copilot-process-wrapper',
    workerSelector: { agent: 'copilot' },
    provider: 'GitHub Copilot SDK agent',
    workspaceClass: 'docker-workspace-volume-snapshot'
  }
];

const state = {
  centralUrl: localStorage.getItem('ars.sample.centralUrl') ?? 'http://localhost:3000',
  tenantId: localStorage.getItem('ars.sample.tenantId') ?? 'poc',
  client: undefined as AgentRuntimeClient | undefined,
  clientEventSubscription: undefined as SdkSubscription | undefined,
  currentSession: undefined as SessionHandle | undefined,
  selectedAgentSpecId: localStorage.getItem('ars.sample.agentSpecId') ?? 'copilot-poc',
  agentSpecDialogOpen: false,
  sessions: [] as SessionSummary[],
  runtimeStatus: { workerPools: [], hostPoolInstances: [], workers: [] } as RuntimeStatus,
  messages: [] as ChatMessage[],
  traceEvents: [] as TraceEvent[],
  pending: false,
  connectionState: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
  error: ''
};

let runtimeStatusTimer: number | undefined;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('missing app root');
}
const appRoot = app;

render();

function render(): void {
  const activeSession = getActiveSessionSummary();
  const selectedAgentSpec = getSelectedAgentSpec();
  const canSend = Boolean(state.currentSession && activeSession?.status === 'running' && !state.pending);
  const canPause = Boolean(state.currentSession && activeSession?.status === 'running' && !state.pending);
  const canResume = Boolean(state.currentSession && activeSession?.status === 'paused' && !state.pending);
  const canRefresh = Boolean(state.currentSession && state.connectionState === 'connected' && !state.pending);
  const statusText = activeSession?.status ?? (state.pending ? 'working' : 'idle');
  appRoot.innerHTML = `
    <main class="shell">
      <aside class="rail">
        <section class="brandBlock">
          <div class="brandMark">AR</div>
          <div>
            <h1>Sidecar Runtime</h1>
            <p>${state.connectionState}</p>
          </div>
        </section>

        <section class="connectionPanel">
          <label>Central URL
            <input id="centralUrl" value="${escapeHtml(state.centralUrl)}" />
          </label>
          <label>Tenant
            <input id="tenantId" value="${escapeHtml(state.tenantId)}" />
          </label>
          <button id="connectButton" class="primary">${state.connectionState === 'connected' ? 'Reconnect' : 'Connect'}</button>
        </section>

        <section class="sessionPanel">
          <div class="panelHeader">
            <span>Sessions</span>
            <button id="newSessionButton" title="Start a new session">+</button>
          </div>
          <div class="sessionList">
            ${state.sessions.map((session) => `
              <button class="sessionItem ${state.currentSession?.id === session.sessionId ? 'active' : ''}" data-session-id="${escapeHtml(session.sessionId)}">
                <span class="sessionItemTop">
                  <span class="sessionStatus"><i class="dot ${escapeHtml(session.status)}"></i>${escapeHtml(session.status)}</span>
                  <small>${escapeHtml(formatTime(session.updatedAt))}</small>
                </span>
                <span class="sessionItemSub">${escapeHtml(shortId(session.sessionId))} · ${escapeHtml(session.agentSpecId)}</span>
              </button>
            `).join('') || '<p class="empty">No sessions yet</p>'}
          </div>
        </section>
      </aside>

      <section class="sessionSurface">
        <header class="sessionHeader">
          <div>
            <span class="eyebrow">Session-Centered Runtime</span>
            <h2>${state.currentSession ? escapeHtml(shortId(state.currentSession.id)) : 'Start a durable agent session'}</h2>
            <p>${state.currentSession ? `AgentSpec ${escapeHtml(activeSession?.agentSpecId ?? selectedAgentSpec.agentSpecId)}` : 'Pick an AgentSpec; central will create the session and scale matching worker capacity.'}</p>
          </div>
          <div class="sessionActions">
            ${canRefresh ? '<button id="refreshSessionButton" class="secondaryButton">Refresh</button>' : ''}
            ${canPause ? '<button id="pauseSessionButton" class="secondaryButton">Pause</button>' : ''}
            ${canResume ? '<button id="resumeSessionButton" class="secondaryButton">Resume</button>' : ''}
            <span class="statusPill ${state.pending ? 'busy' : ''}">${escapeHtml(statusText)}</span>
          </div>
        </header>

        ${renderSessionLifecycle(activeSession)}

        <div class="sessionBody" id="chatBody">
          <div class="messageStack" id="messageStack">
            ${state.messages.map(renderMessage).join('') || (state.currentSession ? renderSessionWorkPanel(activeSession) : renderStartPanel(selectedAgentSpec))}
          </div>
          <aside class="tracePanel">
            <div class="panelHeader"><span>Runtime Events</span><small>${state.traceEvents.length ? `${state.traceEvents.length} events` : 'waiting'}</small></div>
            <div class="traceList" id="traceList">
              ${state.traceEvents.map(renderTraceEvent).join('') || '<p class="empty">Session events will appear after create, assignment, turns, and pause.</p>'}
            </div>
          </aside>
        </div>

        ${state.currentSession ? `
          <form id="composer" class="composer">
            <textarea id="prompt" rows="1" placeholder="${canSend ? 'Message the agent' : 'Input unlocks when the session is running'}" ${canSend ? '' : 'disabled'}></textarea>
            <button class="sendButton" ${canSend ? '' : 'disabled'}>Send</button>
          </form>
        ` : ''}
        ${state.error ? `<div class="errorBanner">${escapeHtml(state.error)}</div>` : ''}
      </section>

      <aside class="runtimeInspector">
        ${renderWorkerPoolInspector()}
      </aside>
      ${state.agentSpecDialogOpen ? renderAgentSpecDialog(selectedAgentSpec) : ''}
    </main>
  `;

  wireEvents();
  scrollChatToEnd();
  scrollTraceToEnd();
}

function wireEvents(): void {
  document.querySelector<HTMLButtonElement>('#connectButton')?.addEventListener('click', () => {
    void connect();
  });
  document.querySelector<HTMLButtonElement>('#newSessionButton')?.addEventListener('click', () => {
    openAgentSpecDialog();
  });
  document.querySelector<HTMLButtonElement>('#startSessionButton')?.addEventListener('click', () => {
    openAgentSpecDialog();
  });
  document.querySelector<HTMLButtonElement>('#confirmStartSessionButton')?.addEventListener('click', () => {
    void startSession();
  });
  document.querySelector<HTMLButtonElement>('#closeAgentSpecDialogButton')?.addEventListener('click', () => {
    closeAgentSpecDialog();
  });
  document.querySelector<HTMLDivElement>('.dialogBackdrop')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) {
      closeAgentSpecDialog();
    }
  });
  document.querySelector<HTMLButtonElement>('#resumeSessionButton')?.addEventListener('click', () => {
    void resumeSession();
  });
  document.querySelector<HTMLButtonElement>('#pauseSessionButton')?.addEventListener('click', () => {
    void pauseSession();
  });
  document.querySelector<HTMLButtonElement>('#refreshSessionButton')?.addEventListener('click', () => {
    void refreshActiveSession();
  });
  document.querySelectorAll<HTMLButtonElement>('.sessionItem').forEach((button) => {
    button.addEventListener('click', () => {
      const sessionId = button.dataset.sessionId;
      if (sessionId) {
        void openSession(sessionId);
      }
    });
  });
  document.querySelector<HTMLFormElement>('#composer')?.addEventListener('submit', (event) => {
    event.preventDefault();
    submitPrompt();
  });
  document.querySelector<HTMLTextAreaElement>('#prompt')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
      return;
    }
    event.preventDefault();
    submitPrompt();
  }, { capture: true });
  document.querySelector<HTMLInputElement>('#centralUrl')?.addEventListener('input', (event) => {
    state.centralUrl = (event.target as HTMLInputElement).value.trim();
    localStorage.setItem('ars.sample.centralUrl', state.centralUrl);
  });
  document.querySelector<HTMLInputElement>('#tenantId')?.addEventListener('input', (event) => {
    state.tenantId = (event.target as HTMLInputElement).value.trim();
    localStorage.setItem('ars.sample.tenantId', state.tenantId);
  });
  document.querySelector<HTMLSelectElement>('#agentSpecSelect')?.addEventListener('change', (event) => {
    state.selectedAgentSpecId = (event.target as HTMLSelectElement).value;
    localStorage.setItem('ars.sample.agentSpecId', state.selectedAgentSpecId);
    render();
  });
}

function submitPrompt(): void {
  const promptInput = document.querySelector<HTMLTextAreaElement>('#prompt');
  const prompt = promptInput?.value.trim();
  if (!prompt || state.pending || !state.currentSession) {
    return;
  }
  if (promptInput) {
    promptInput.value = '';
  }
  void sendMessage(prompt);
}

function openAgentSpecDialog(): void {
  state.agentSpecDialogOpen = true;
  state.error = '';
  render();
}

function closeAgentSpecDialog(): void {
  state.agentSpecDialogOpen = false;
  render();
}

async function connect(): Promise<void> {
  syncConnectionInputs();
  state.connectionState = 'connecting';
  state.error = '';
  render();
  try {
    await state.clientEventSubscription?.close();
    await state.client?.close();
    state.client = new AgentRuntimeClient({ centralUrl: state.centralUrl, tenantId: state.tenantId });
    await state.client.connect();
    state.clientEventSubscription = await state.client.subscribeClientEvents((event) => {
      if (event.type !== 'session.catalog.updated' && event.type !== 'session.status.updated') {
        return;
      }
      recordClientProjection(event);
      void refreshSessions().then(() => render()).catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error);
        render();
      });
    });
    await refreshSessions();
    await refreshRuntimeStatus();
    startRuntimeStatusPolling();
    clearMissingCurrentSession();
    state.connectionState = 'connected';
  } catch (error) {
    state.connectionState = 'error';
    state.error = error instanceof Error ? error.message : String(error);
  }
  render();
}

function startRuntimeStatusPolling(): void {
  if (runtimeStatusTimer !== undefined) {
    window.clearInterval(runtimeStatusTimer);
  }
  runtimeStatusTimer = window.setInterval(() => {
    void refreshRuntimeStatus().then(() => render()).catch((error: unknown) => {
      state.error = error instanceof Error ? error.message : String(error);
      render();
    });
  }, 1500);
}

function syncConnectionInputs(): void {
  const centralUrl = document.querySelector<HTMLInputElement>('#centralUrl')?.value.trim();
  const tenantId = document.querySelector<HTMLInputElement>('#tenantId')?.value.trim();
  if (centralUrl) {
    state.centralUrl = centralUrl;
    localStorage.setItem('ars.sample.centralUrl', centralUrl);
  }
  if (tenantId) {
    state.tenantId = tenantId;
    localStorage.setItem('ars.sample.tenantId', tenantId);
  }
}

async function startSession(): Promise<void> {
  await ensureConnected();
  state.error = '';
  state.agentSpecDialogOpen = false;
  state.traceEvents = [];
  state.messages = [];
  state.pending = true;
  render();
  try {
    const result = await state.client!.sessions.start({
      agent: state.selectedAgentSpecId,
      input: { message: `Start a new ${state.selectedAgentSpecId} session.` },
      workspace: { source: 'empty' },
      displayName: `${state.selectedAgentSpecId} session`
    });
    state.currentSession = result.session;
    await refreshSessions();
    await refreshRuntimeStatus();
    state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: result.turn.sequence, label: 'session.created', detail: `turn ${result.turn.sequence}` });
    appendLifecycleTrace('status.queued', result.session.id);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.pending = false;
    render();
  }
}

async function openSession(sessionId: string): Promise<void> {
  await ensureConnected();
  state.currentSession = await state.client!.sessions.open(sessionId);
  const history = await state.currentSession.history(0);
  restoreViewFromHistory(history);
  appendLifecycleTrace('history.opened', sessionId);
  await refreshSessions();
  render();
}

async function sendMessage(text: string): Promise<void> {
  if (!state.currentSession) {
    return;
  }
  state.pending = true;
  state.error = '';
  const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', text };
  state.messages.push(userMessage);
  render();
  try {
    const turn = await state.currentSession.send({ message: text });
    let assistantText = '';
    for await (const event of turn.events()) {
      applyTurnEvent(event, (nextText) => {
        assistantText = nextText;
      });
    }
    if (assistantText) {
      state.messages.push({ id: crypto.randomUUID(), role: 'assistant', text: assistantText, turnSeq: turn.sequence });
    }
    await refreshSessions();
    await refreshRuntimeStatus();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.pending = false;
    render();
  }
}

async function resumeSession(): Promise<void> {
  if (!state.currentSession) {
    return;
  }
  state.pending = true;
  state.error = '';
  render();
  try {
    appendLifecycleTrace('resume.requested', state.currentSession.id);
    await state.currentSession.resume();
    await waitForActiveSessionStatus(['queued', 'starting', 'running'], 15_000);
    await refreshRuntimeStatus();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.pending = false;
    render();
  }
}

async function pauseSession(): Promise<void> {
  if (!state.currentSession) {
    return;
  }
  state.pending = true;
  state.error = '';
  render();
  try {
    appendLifecycleTrace('pause.requested', state.currentSession.id);
    await state.currentSession.pause();
    await waitForActiveSessionStatus(['pausing', 'paused'], 10_000);
    await waitForActiveSessionStatus(['paused'], 30_000);
    await refreshRuntimeStatus();
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.pending = false;
    render();
  }
}

async function refreshActiveSession(): Promise<void> {
  if (!state.currentSession) {
    return;
  }
  state.pending = true;
  state.error = '';
  render();
  try {
    const sessionId = state.currentSession.id;
    const history = await state.currentSession.history(0);
    restoreViewFromHistory(history);
    await refreshSessions();
    await refreshRuntimeStatus();
    appendLifecycleTrace('history.refreshed', sessionId);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.pending = false;
    render();
  }
}

async function refreshSessions(): Promise<void> {
  if (!state.client) {
    state.sessions = [];
    return;
  }
  state.sessions = await state.client.sessions.list();
}

async function refreshRuntimeStatus(): Promise<void> {
  if (state.connectionState !== 'connected' && !state.client) {
    return;
  }
  const url = new URL('/runtime/status', state.centralUrl);
  url.searchParams.set('tenantId', state.tenantId);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`runtime status failed with HTTP ${response.status}`);
  }
  state.runtimeStatus = await response.json() as RuntimeStatus;
}

async function waitForActiveSessionStatus(statuses: string[], timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    await refreshSessions();
    const activeSession = getActiveSessionSummary();
    if (activeSession && statuses.includes(activeSession.status)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function getActiveSessionSummary(): SessionSummary | undefined {
  if (!state.currentSession) {
    return undefined;
  }
  return state.sessions.find((session) => session.sessionId === state.currentSession?.id);
}

function clearMissingCurrentSession(): void {
  if (!state.currentSession) {
    return;
  }
  if (state.sessions.some((session) => session.sessionId === state.currentSession?.id)) {
    return;
  }
  state.currentSession = undefined;
  state.messages = [];
  state.traceEvents = [];
}

function recordClientProjection(event: SdkRuntimeEvent): void {
  const payload = toRecord(event.payload);
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : event.sessionId;
  if (!sessionId || sessionId !== state.currentSession?.id) {
    return;
  }
  const status = typeof payload.status === 'string' ? payload.status : undefined;
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  appendLifecycleTrace(event.type, sessionId, [status, reason].filter(Boolean).join(' · '));
}

function appendLifecycleTrace(label: string, sessionId: string, detail?: string): void {
  state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: 0, label, detail: detail || shortId(sessionId) });
}

function applyTurnEvent(event: AgentTurnEvent, setAssistantText: (text: string) => void): void {
  switch (event.type) {
    case 'turn.started':
      state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: event.turnSeq, label: 'turn.started' });
      break;
    case 'agent.progress':
      state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: event.turnSeq, label: 'progress', detail: event.message });
      break;
    case 'assistant.delta':
      state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: event.turnSeq, label: 'assistant.delta', detail: event.text });
      break;
    case 'agent.internal':
      state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: event.turnSeq, label: event.label, detail: stringifyBrief(event.detail) });
      break;
    case 'tool.started':
      state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: event.turnSeq, label: `tool.started ${event.toolName}`, detail: stringifyBrief(event.inputSummary) });
      break;
    case 'tool.completed':
      state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: event.turnSeq, label: `tool.completed ${event.toolName}`, detail: stringifyBrief(event.outputSummary) });
      break;
    case 'approval.requested':
      state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: event.turnSeq, label: 'approval.requested', detail: stringifyBrief(event.approval) });
      break;
    case 'turn.completed':
      setAssistantText(event.result.message ?? stringifyBrief(event.result.output));
      state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: event.turnSeq, label: 'turn.completed', detail: event.result.message });
      break;
    case 'turn.failed':
      state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: event.turnSeq, label: 'turn.failed', detail: event.error.message });
      break;
  }
  render();
}

async function ensureConnected(): Promise<void> {
  if (state.connectionState === 'connected' && state.client) {
    return;
  }
  await connect();
  if (!state.client || state.connectionState !== 'connected') {
    throw new Error('sample is not connected to central');
  }
}

function getSelectedAgentSpec(): AgentSpecOption {
  return AGENT_SPECS.find((agentSpec) => agentSpec.agentSpecId === state.selectedAgentSpecId) ?? AGENT_SPECS[0];
}

function renderStartPanel(agentSpec: AgentSpecOption): string {
  const canStart = state.connectionState === 'connected' && !state.pending;
  return `
    <div class="startPanel">
      <div class="startCopy">
        <span class="eyebrow">Create Session</span>
        <h3>Start from an AgentSpec, not from a machine.</h3>
        <p>Click Sessions + to choose an AgentSpec. Central creates a durable session, matches WorkerPool labels, scales Docker capacity, and assigns the session after a sidecar registers as a Worker.</p>
      </div>
      <div class="selectedSpecPreview">
        <span>Selected AgentSpec</span>
        <strong>${escapeHtml(agentSpec.agentSpecId)}</strong>
        <em>${escapeHtml(labelString(agentSpec.workerSelector))}</em>
      </div>
      <button id="startSessionButton" class="startSessionButton" ${canStart ? '' : 'disabled'}>Choose AgentSpec</button>
    </div>
  `;
}

function renderSessionLifecycle(activeSession: SessionSummary | undefined): string {
  if (!activeSession) {
    return '';
  }
  const status = activeSession.status;
  const normalized = status === 'pausing' ? 'running' : status;
  const stages = [
    { key: 'queued', label: 'Queued' },
    { key: 'starting', label: 'Starting' },
    { key: 'running', label: 'Running' },
    { key: 'paused', label: 'Paused' }
  ];
  const currentIndex = stages.findIndex((stage) => stage.key === normalized);
  const failed = status === 'failed';
  return `
    <div class="lifecycle" aria-label="Session lifecycle">
      ${stages.map((stage, index) => {
        const done = currentIndex > index;
        const active = currentIndex === index && !failed;
        return `<span class="lifeStage ${done ? 'done' : ''} ${active ? 'active' : ''}"><i></i>${escapeHtml(stage.label)}</span>`;
      }).join('')}
      ${status === 'pausing' ? '<span class="lifeNote">pausing…</span>' : ''}
      ${failed ? '<span class="lifeStage failed active"><i></i>Failed</span>' : ''}
    </div>
  `;
}

function renderSessionWorkPanel(activeSession: SessionSummary | undefined): string {
  const status = activeSession?.status ?? 'queued';
  return `
    <div class="sessionWorkPanel">
      <span class="eyebrow">Session Requested</span>
      <h3>${escapeHtml(sessionWorkTitle(status))}</h3>
      <p>${escapeHtml(sessionWorkDetail(status))}</p>
      <div class="workSignals">
        <span>${escapeHtml(state.selectedAgentSpecId)}</span>
        <span>${escapeHtml(workerPoolSignal())}</span>
        <span>${escapeHtml(workerSignal())}</span>
      </div>
    </div>
  `;
}

function sessionWorkTitle(status: string): string {
  if (status === 'queued') {
    return 'Central accepted the session and is scaling matching capacity.';
  }
  if (status === 'starting') {
    return 'A Worker was selected and the sidecar is starting the agent.';
  }
  if (status === 'paused') {
    return 'The session is paused and worker capacity has been released.';
  }
  return `Session is ${status}.`;
}

function sessionWorkDetail(status: string): string {
  if (status === 'queued') {
    return 'Watch the runtime inspector: the WorkerPool should create a host instance, then a sidecar registers as a Worker with matching labels.';
  }
  if (status === 'starting') {
    return 'The session now has a lease. The sidecar prepares workspace state and starts the configured AgentSpec runtime.';
  }
  if (status === 'paused') {
    return 'The durable session remains in central storage while Docker capacity scales in.';
  }
  return 'Runtime events and worker state are shown in the inspector.';
}

function workerPoolSignal(): string {
  const instance = state.runtimeStatus.hostPoolInstances.find((candidate) => candidate.state === 'pending' || candidate.state === 'ready' || candidate.state === 'stopping') ?? state.runtimeStatus.hostPoolInstances[0];
  return instance ? `host ${instance.state}` : 'host waiting';
}

function workerSignal(): string {
  const worker = state.runtimeStatus.workers.find((candidate) => candidate.lifecycleState === 'active' || candidate.lifecycleState === 'registered') ?? state.runtimeStatus.workers[0];
  return worker ? `worker ${worker.lifecycleState}/${worker.conditions.join(',')}` : 'worker not registered';
}

function renderWorkerPoolInspector(): string {
  const connected = state.connectionState === 'connected';
  const poolCount = state.runtimeStatus.workerPools.length;
  const note = !connected ? 'connect to inspect' : poolCount ? `${poolCount} pool${poolCount === 1 ? '' : 's'}` : 'none configured';
  return `
    <div class="inspectorHead"><span>WorkerPools</span><small>${escapeHtml(note)}</small></div>
    <div class="inspectorScroll">${renderWorkerPools()}</div>
  `;
}

function renderAgentSpecDialog(agentSpec: AgentSpecOption): string {
  const canStart = state.connectionState === 'connected' && !state.pending;
  return `
    <div class="dialogBackdrop" role="presentation">
      <section class="agentSpecDialog" role="dialog" aria-modal="true" aria-labelledby="agentSpecDialogTitle">
        <header>
          <div>
            <span class="eyebrow">New Session</span>
            <h3 id="agentSpecDialogTitle">Choose AgentSpec</h3>
            <p>The AgentSpec defines the type of agent session. Its selector is matched against WorkerPool labels when central needs capacity.</p>
          </div>
          <button id="closeAgentSpecDialogButton" class="iconButton" aria-label="Close AgentSpec dialog">×</button>
        </header>
        <div class="agentSpecDialogBody">
          <label for="agentSpecSelect">AgentSpec</label>
          <select id="agentSpecSelect">
            ${AGENT_SPECS.map((candidate) => `<option value="${escapeHtml(candidate.agentSpecId)}" ${candidate.agentSpecId === agentSpec.agentSpecId ? 'selected' : ''}>${escapeHtml(candidate.agentSpecId)}</option>`).join('')}
          </select>
          <dl>
            <dt>agent</dt><dd>${escapeHtml(agentSpec.title)}</dd>
            <dt>selector</dt><dd>${escapeHtml(labelString(agentSpec.workerSelector))}</dd>
            <dt>sidecar</dt><dd>${escapeHtml(agentSpec.sidecarClass)}</dd>
            <dt>workspace</dt><dd>${escapeHtml(agentSpec.workspaceClass)}</dd>
            <dt>provider</dt><dd>${escapeHtml(agentSpec.provider)}</dd>
          </dl>
        </div>
        <footer>
          <button id="confirmStartSessionButton" class="startSessionButton" ${canStart ? '' : 'disabled'}>Create Session</button>
        </footer>
      </section>
    </div>
  `;
}

function renderWorkerPools(): string {
  if (state.connectionState !== 'connected') {
    return '<p class="inspectorEmpty">Connect to a tenant to inspect WorkerPool capacity.</p>';
  }
  if (state.runtimeStatus.workerPools.length === 0) {
    return '<p class="inspectorEmpty">Central has no WorkerPool configured for this tenant.</p>';
  }
  return state.runtimeStatus.workerPools.map((pool) => {
    const poolInstances = state.runtimeStatus.hostPoolInstances.filter((instance) => instance.poolId === pool.poolId);
    const liveInstances = poolInstances.filter((instance) => instance.state === 'pending' || instance.state === 'ready' || instance.state === 'stopping');
    const retiredInstances = poolInstances.length - liveInstances.length;
    const poolWorkers = state.runtimeStatus.workers.filter((worker) => worker.description?.workerPoolId === pool.poolId || matchesLabels(worker.labels, pool.labels));
    const liveWorkers = poolWorkers.filter((worker) => worker.lifecycleState === 'registered' || worker.lifecycleState === 'active');
    const retiredWorkers = poolWorkers.length - liveWorkers.length;
    return `
      <article class="poolCard">
        <header class="poolCardHead">
          <strong title="${escapeHtml(pool.poolId)}">${escapeHtml(pool.poolId)}</strong>
          <span class="poolBadge">${escapeHtml(pool.hostPoolControllerClass)}</span>
        </header>
        <p class="poolMeta">${escapeHtml(labelString(pool.labels))} · cap ${pool.capacityPerWorker} · idle ${pool.scalePolicy.scaleInIdleMs / 1000}s</p>
        <div class="poolGroup">
          <div class="poolGroupHead"><span>Host instances</span><small>${liveInstances.length || ''}</small></div>
          ${liveInstances.length ? liveInstances.map(renderHostPoolInstance).join('') : '<p class="groupEmpty">Waiting for queued sessions.</p>'}
          ${retiredInstances ? `<p class="retiredNote">+ ${retiredInstances} retired</p>` : ''}
        </div>
        <div class="poolGroup">
          <div class="poolGroupHead"><span>Workers</span><small>${liveWorkers.length || ''}</small></div>
          ${liveWorkers.length ? liveWorkers.map(renderWorkerMini).join('') : '<p class="groupEmpty">No worker registered yet.</p>'}
          ${retiredWorkers ? `<p class="retiredNote">+ ${retiredWorkers} retired</p>` : ''}
        </div>
      </article>
    `;
  }).join('');
}

function renderHostPoolInstance(instance: HostPoolInstanceSummary): string {
  return `
    <div class="capRow" title="${escapeHtml(instance.containerId ?? instance.instanceId)}">
      <span class="capState"><i class="dot ${escapeHtml(instance.state)}"></i><span>${escapeHtml(instance.state)}</span></span>
      <span class="capId">${escapeHtml(shortId(instance.instanceId))}</span>
      <span class="capNote">${instance.workerId ? `&rarr; worker ${escapeHtml(shortId(instance.workerId))}` : 'worker pending'}</span>
    </div>
  `;
}

function renderWorkerMini(worker: WorkerSummary): string {
  const stateText = `${worker.lifecycleState} / ${worker.conditions.join(', ')}`;
  return `
    <div class="capRow">
      <span class="capState"><i class="dot ${escapeHtml(worker.lifecycleState)}"></i><span>${escapeHtml(stateText)}</span></span>
      <span class="capId">${escapeHtml(shortId(worker.workerId))}</span>
      <span class="workerMetaLine">
        <span>${escapeHtml(labelString(worker.labels))}</span>
        <span>${worker.currentSessionCount} session${worker.currentSessionCount === 1 ? '' : 's'}</span>
        <span>${worker.allocatable}/${worker.capacity} free</span>
      </span>
    </div>
  `;
}

function labelString(labels: Record<string, string>): string {
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(', ');
}

function matchesLabels(labels: Record<string, string>, selector: Record<string, string>): boolean {
  return Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function restoreViewFromHistory(events: SdkRuntimeEvent[]): void {
  state.messages = [];
  state.traceEvents = [];
  const assistantMessagesByTurn = new Map<number, ChatMessage>();
  for (const event of events) {
    const payload = toRecord(event.payload);
    if (event.type === 'session.created') {
      const input = toRecord(payload.input);
      if (typeof input.message === 'string') {
        state.messages.push({ id: event.eventId, role: 'user', text: input.message, turnSeq: event.turnSeq });
      }
      state.traceEvents.push({ id: `${event.eventId}:created`, turnSeq: event.turnSeq ?? 0, label: 'session.created' });
      continue;
    }
    if (event.type === 'input.accepted') {
      const input = toRecord(payload.input);
      if (typeof input.message === 'string') {
        state.messages.push({ id: event.eventId, role: 'user', text: input.message, turnSeq: event.turnSeq });
      }
      state.traceEvents.push({ id: `${event.eventId}:accepted`, turnSeq: event.turnSeq ?? 0, label: 'input.accepted' });
      continue;
    }
    if (event.type === 'agent.output') {
      const turnSeq = event.turnSeq ?? 0;
      if (typeof payload.progress === 'string') {
        state.traceEvents.push({ id: `${event.eventId}:progress`, turnSeq, label: 'progress', detail: payload.progress });
      }
      const internalEvent = toRecord(payload.internalEvent);
      if (typeof internalEvent.type === 'string') {
        state.traceEvents.push({ id: `${event.eventId}:internal`, turnSeq, label: internalEvent.type, detail: stringifyBrief(internalEvent.data) });
      }
      if (typeof payload.message === 'string') {
        upsertAssistantMessage(assistantMessagesByTurn, turnSeq, payload.message);
      }
    }
    if (event.type === 'session.pause.requested' || event.type === 'session.paused' || event.type === 'session.resume.requested' || event.type === 'session.resumed' || event.type === 'status.changed') {
      const status = typeof payload.status === 'string' ? payload.status : undefined;
      const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
      state.traceEvents.push({ id: `${event.eventId}:lifecycle`, turnSeq: event.turnSeq ?? 0, label: event.type, detail: [status, reason].filter(Boolean).join(' · ') });
    }
  }
}

function upsertAssistantMessage(assistantMessagesByTurn: Map<number, ChatMessage>, turnSeq: number, text: string): void {
  const existingMessage = assistantMessagesByTurn.get(turnSeq);
  if (existingMessage) {
    existingMessage.text = text;
    return;
  }
  const message: ChatMessage = { id: `assistant:${turnSeq}`, role: 'assistant', text, turnSeq };
  assistantMessagesByTurn.set(turnSeq, message);
  state.messages.push(message);
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function renderMessage(message: ChatMessage): string {
  return `
    <article class="message ${message.role}">
      <div class="avatar">${message.role === 'user' ? 'You' : 'AR'}</div>
      <div class="bubble">
        <p>${escapeHtml(message.text)}</p>
      </div>
    </article>
  `;
}

function renderTraceEvent(event: TraceEvent): string {
  return `
    <div class="traceEvent">
      <span>${event.turnSeq > 0 ? `turn ${event.turnSeq}` : 'session'}</span>
      <strong>${escapeHtml(event.label)}</strong>
      ${event.detail ? `<p>${escapeHtml(event.detail)}</p>` : ''}
    </div>
  `;
}

function scrollChatToEnd(): void {
  const stack = document.querySelector<HTMLDivElement>('#messageStack');
  if (stack) {
    stack.scrollTop = stack.scrollHeight;
  }
}

function scrollTraceToEnd(): void {
  const trace = document.querySelector<HTMLDivElement>('#traceList');
  if (trace) {
    trace.scrollTop = trace.scrollHeight;
  }
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function stringifyBrief(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  return JSON.stringify(value).slice(0, 500);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
