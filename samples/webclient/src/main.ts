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

const state = {
  centralUrl: localStorage.getItem('ars.sample.centralUrl') ?? 'http://localhost:3000',
  tenantId: localStorage.getItem('ars.sample.tenantId') ?? 'poc',
  client: undefined as AgentRuntimeClient | undefined,
  clientEventSubscription: undefined as SdkSubscription | undefined,
  currentSession: undefined as SessionHandle | undefined,
  sessions: [] as SessionSummary[],
  messages: [] as ChatMessage[],
  traceEvents: [] as TraceEvent[],
  pending: false,
  connectionState: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error',
  error: ''
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('missing app root');
}
const appRoot = app;

render();

function render(): void {
  const activeSession = getActiveSessionSummary();
  const canSend = Boolean(state.currentSession && activeSession?.status === 'running' && !state.pending);
  appRoot.innerHTML = `
    <main class="shell">
      <aside class="rail">
        <section class="brandBlock">
          <div class="brandMark">AR</div>
          <div>
            <h1>Runtime Chat</h1>
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
                <span>${escapeHtml(shortId(session.sessionId))}</span>
                <em>${escapeHtml(session.status)} · ${escapeHtml(session.agentSpecId)}</em>
                <small>${formatTime(session.updatedAt)}</small>
              </button>
            `).join('') || '<p class="empty">No sessions yet</p>'}
          </div>
        </section>

        <section class="agentSpecPanel">
          <div class="panelHeader"><span>AgentSpec</span></div>
          <dl>
            <dt>agentSpecId</dt><dd>copilot-poc</dd>
            <dt>sidecarClass</dt><dd>copilot-process-wrapper</dd>
            <dt>workerSelector</dt><dd>agent=copilot</dd>
            <dt>provider</dt><dd>GitHub Copilot SDK agent</dd>
          </dl>
        </section>
      </aside>

      <section class="chatSurface">
        <header class="chatHeader">
          <div>
            <span class="eyebrow">Durable Session</span>
            <h2>${state.currentSession ? escapeHtml(shortId(state.currentSession.id)) : 'No active session'}</h2>
          </div>
          <span class="statusPill ${state.pending ? 'busy' : ''}">${state.pending ? 'running' : escapeHtml(activeSession?.status ?? 'idle')}</span>
        </header>

        <div class="chatBody" id="chatBody">
          <div class="messageStack" id="messageStack">
            ${state.messages.map(renderMessage).join('') || renderWelcome()}
          </div>
          <aside class="tracePanel">
            <div class="panelHeader"><span>Agent Events</span></div>
            <div class="traceList" id="traceList">
              ${state.traceEvents.map(renderTraceEvent).join('') || '<p class="empty">Waiting for agent events</p>'}
            </div>
          </aside>
        </div>

        <form id="composer" class="composer">
          <textarea id="prompt" rows="1" placeholder="Message the agent" ${canSend ? '' : 'disabled'}></textarea>
          <button class="sendButton" ${canSend ? '' : 'disabled'}>Send</button>
        </form>
        ${state.error ? `<div class="errorBanner">${escapeHtml(state.error)}</div>` : ''}
      </section>
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
    void startSession();
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
      void refreshSessions().then(() => render()).catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error);
        render();
      });
    });
    await refreshSessions();
    clearMissingCurrentSession();
    state.connectionState = 'connected';
  } catch (error) {
    state.connectionState = 'error';
    state.error = error instanceof Error ? error.message : String(error);
  }
  render();
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
  state.traceEvents = [];
  state.messages = [];
  state.pending = true;
  render();
  try {
    const result = await state.client!.sessions.start({
      agent: 'copilot-poc',
      input: { message: 'Start a new runtime-backed chat session.' },
      workspace: { source: 'empty' },
      displayName: 'Runtime chat'
    });
    state.currentSession = result.session;
    await refreshSessions();
    state.traceEvents.push({ id: crypto.randomUUID(), turnSeq: result.turn.sequence, label: 'session.created', detail: `turn ${result.turn.sequence}` });
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

function renderWelcome(): string {
  return `
    <div class="welcome">
      <h3>Start a session to talk through the runtime.</h3>
      <p>The sample keeps session handles local to this browser and streams agent events through the SDK.</p>
    </div>
  `;
}

function restoreViewFromHistory(events: SdkRuntimeEvent[]): void {
  state.messages = [];
  state.traceEvents = [];
  const assistantByTurn = new Map<number, string>();
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
        assistantByTurn.set(turnSeq, payload.message);
      }
    }
  }
  for (const [turnSeq, text] of assistantByTurn) {
    state.messages.push({ id: `assistant:${turnSeq}`, role: 'assistant', text, turnSeq });
  }
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
      <span>turn ${event.turnSeq}</span>
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
