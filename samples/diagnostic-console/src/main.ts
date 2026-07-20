import { AgentRuntimeClient, type SessionEvent, type SessionHandle, type SessionStatus } from '@agent-runtime-sidecar/sdk';
import DOMPurify from 'dompurify';
import {
  Activity,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Cpu,
  createIcons,
  Gauge,
  HardDrive,
  Network,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  X
} from 'lucide';
import { marked } from 'marked';

const AGENT_SPEC_ID = 'diagnostic-expert';

interface DiagnosticAction {
  id: string;
  title: string;
  detail: string;
  icon: string;
  prompt: string;
  local: boolean;
}

interface ConversationTurn {
  sequence: number;
  userText: string;
  assistantText: string;
  complete: boolean;
  failed: boolean;
  error?: string;
}

type LocalScanStage = 'requested' | 'delegating' | 'awaiting_approval' | 'authorized' | 'scanning' | 'evidence_ready' | 'complete' | 'failed';

interface LocalScan {
  actionId: string;
  title: string;
  detail: string;
  stage: LocalScanStage;
}

interface PendingApproval {
  interactionId: string;
  submitting: boolean;
}

const localActions: DiagnosticAction[] = [
  {
    id: 'performance',
    title: 'Why is my machine slow?',
    detail: 'CPU, memory, disk and process pressure',
    icon: 'Gauge',
    local: true,
    prompt: 'My machine feels unusually slow. Build a hypothesis-driven diagnosis and inspect this machine for current CPU, memory, disk, process, and resource pressure. Use read-only checks only. Separate observed facts from likely causes and recommend the single best next step.'
  },
  {
    id: 'updates',
    title: 'Check missing updates',
    detail: 'OS, drivers and developer toolchain',
    icon: 'refresh-cw',
    local: true,
    prompt: 'Check whether this machine has important operating-system, driver, runtime, package-manager, or developer-tool updates pending. Use read-only inspection only and do not install anything. Prioritize updates that plausibly affect stability, security, or performance.'
  },
  {
    id: 'boot',
    title: 'Analyze slow startup',
    detail: 'Boot phases, services and startup apps',
    icon: 'clock-3',
    local: true,
    prompt: 'Diagnose why this machine may be slow to boot or become responsive after sign-in. Inspect available boot timing evidence, uptime, startup applications, service state, and relevant bounded logs using read-only checks. Identify the most likely bottleneck and explain the evidence.'
  },
  {
    id: 'docker',
    title: 'Docker & WSL health',
    detail: 'Daemon, contexts, virtualization and storage',
    icon: 'Cpu',
    local: true,
    prompt: 'Run a read-only health diagnosis for Docker and WSL on this machine. Check CLI and daemon availability, active context, WSL state, virtualization indicators, disk pressure, and relevant errors. Do not start, stop, reset, prune, or modify anything.'
  },
  {
    id: 'network',
    title: 'Network feels unstable',
    detail: 'DNS, routes, proxy and local connectivity',
    icon: 'Network',
    local: true,
    prompt: 'Diagnose intermittent or slow network behavior on this machine using bounded read-only checks. Inspect DNS, routes, proxy configuration, adapter state, localhost connectivity, clock, and a small number of safe connectivity probes. Redact private endpoint details.'
  },
  {
    id: 'storage',
    title: 'Find storage pressure',
    detail: 'Capacity, hot paths and filesystem signals',
    icon: 'hard-drive',
    local: true,
    prompt: 'Inspect this machine for storage pressure using read-only checks. Check free space, filesystem status, unusually large high-level locations where permitted, and signs that low disk space is affecting development tools. Do not delete or modify files.'
  }
];

const generalActions: DiagnosticAction[] = [
  {
    id: 'freeze-guide',
    title: 'Why do computers freeze intermittently?',
    detail: 'A general diagnostic decision tree',
    icon: 'circle-help',
    local: false,
    prompt: 'Explain the most common causes of intermittent computer freezes and give me a concise hypothesis-driven diagnostic decision tree. Answer from general knowledge only; do not inspect the local machine.'
  },
  {
    id: 'workstation-checklist',
    title: 'Developer workstation checklist',
    detail: 'A preventive maintenance plan',
    icon: 'shield-check',
    local: false,
    prompt: 'Create a practical monthly health checklist for a developer workstation. Cover reliability, security, updates, storage, containers, networking, and backups. Answer from general knowledge only; do not inspect the local machine.'
  }
];

const state = {
  centralUrl: readCentralUrl(),
  tenantId: new URLSearchParams(location.search).get('tenant') ?? 'poc',
  client: undefined as AgentRuntimeClient | undefined,
  session: undefined as SessionHandle | undefined,
  sessionStatus: 'unknown' as SessionStatus,
  connection: 'connecting' as 'connecting' | 'connected' | 'error',
  turns: new Map<number, ConversationTurn>(),
  localScan: undefined as LocalScan | undefined,
  approvals: new Map<string, PendingApproval>(),
  trustedForSession: false,
  sending: false,
  settingsOpen: false,
  error: '',
  observeAbort: undefined as AbortController | undefined
};

const root = document.querySelector<HTMLDivElement>('#app')!;
let renderScheduled = false;
let conversationScrollTop = 0;
let followConversationTail = true;

syncShareableConnectionUrl();
void connect();

async function connect(): Promise<void> {
  state.connection = 'connecting';
  state.error = '';
  render();
  try {
    const client = new AgentRuntimeClient({ centralUrl: state.centralUrl, tenantId: state.tenantId });
    await client.connect();
    state.client = client;
    state.connection = 'connected';
  } catch (error) {
    state.connection = 'error';
    state.error = errorMessage(error);
  }
  render();
}

function render(): void {
  captureConversationScroll();
  const hasConversation = state.turns.size > 0;
  const approval = [...state.approvals.values()][0];
  root.innerHTML = `
    <div class="appShell">
      <header class="topBar">
        <div class="brandBlock">
          <span class="brandMark"><i data-lucide="Activity"></i></span>
          <span class="brandName">SignalOS</span>
          <span class="brandDescriptor">Agentic diagnostics</span>
        </div>
        <div class="topActions">
          ${state.trustedForSession ? '<span class="trustBadge"><i data-lucide="shield-check"></i> Local access granted</span>' : ''}
          <span class="connectionState ${state.connection}"><span></span>${connectionLabel()}</span>
          <button class="iconButton" id="settingsButton" title="Connection settings" aria-label="Connection settings"><i data-lucide="settings-2"></i></button>
          <button class="newButton" id="newSession" ${hasActiveDiagnosis() ? 'disabled title="Wait for the current diagnosis to finish"' : ''}><i data-lucide="Plus"></i><span>New</span></button>
        </div>
      </header>

      <div class="workspace">
        <aside class="actionRail">
          <div class="railHeading">
            <span>Quick diagnostics</span>
            <small>LOCAL SCANS</small>
          </div>
          <div class="actionList">
            ${localActions.map(renderAction).join('')}
          </div>
          <div class="railHeading secondaryHeading">
            <span>Ask an expert</span>
            <small>NO DEVICE ACCESS</small>
          </div>
          <div class="generalList">
            ${generalActions.map(renderAction).join('')}
          </div>
          <div class="railSignal" aria-hidden="true">
            <span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span>
          </div>
        </aside>

        <main class="chatSurface">
          <div class="chatHeader">
            <div>
              <span class="eyebrow">DIAGNOSTIC CHANNEL</span>
              <h1>Chat with Diagnostic Expert</h1>
            </div>
            <div class="sessionReadout">
              <span>${sessionStatusLabel()}</span>
              <small>${state.session ? shortSessionId(state.session.id) : 'NEW CASE'}</small>
            </div>
          </div>

          <section class="conversation" id="conversation" aria-live="polite">
            ${isWaitingForExpert() ? renderExpertWait() : hasConversation ? renderConversation() : renderWelcome()}
          </section>

          ${state.error ? `<div class="errorBanner"><i data-lucide="TriangleAlert"></i><span>${esc(state.error)}</span><button id="dismissError" aria-label="Dismiss error"><i data-lucide="X"></i></button></div>` : ''}

          <form class="composer" id="composer">
            <textarea id="messageInput" rows="1" placeholder="Describe what feels wrong…" aria-label="Diagnostic question" ${state.connection !== 'connected' || state.sending ? 'disabled' : ''}></textarea>
            <div class="composerMeta">
              <span><i data-lucide="Sparkles"></i> Diagnostic Expert chooses the safest next check</span>
              <button type="submit" class="sendButton" aria-label="Send message" ${state.connection !== 'connected' || state.sending ? 'disabled' : ''}>
                ${state.sending ? '<i class="spin" data-lucide="refresh-cw"></i>' : '<i data-lucide="arrow-right"></i>'}
              </button>
            </div>
          </form>
        </main>

      </div>
    </div>
    ${approval && !state.trustedForSession ? renderApproval(approval) : ''}
    ${state.settingsOpen ? renderSettings() : ''}
  `;

  hydrateIcons();
  bindEvents();
  restoreConversationScroll();
}

function renderAction(action: DiagnosticAction): string {
  return `
    <button class="diagnosticAction ${action.local ? '' : 'generalAction'}" data-action="${action.id}" ${state.connection !== 'connected' || state.sending ? 'disabled' : ''}>
      <span class="actionIcon"><i data-lucide="${action.icon}"></i></span>
      <span class="actionCopy"><strong>${esc(action.title)}${action.local ? '<em>DEVICE</em>' : ''}</strong><small>${esc(action.detail)}</small></span>
      <i class="chevron" data-lucide="chevron-right"></i>
    </button>`;
}

function renderWelcome(): string {
  return `
    <div class="welcome">
      <div class="welcomeVisual" aria-hidden="true">
        <div class="scanDisc"><i data-lucide="Activity"></i><span></span></div>
        <div class="coordinate c1">CPU / 00</div>
        <div class="coordinate c2">NET / READY</div>
        <div class="coordinate c3">SYS / WAITING</div>
      </div>
      <div class="welcomeCopy">
        <span class="eyebrow">EVIDENCE-LED SUPPORT</span>
        <h2>What should we investigate?</h2>
        <p>Describe the symptom, or start with a focused scan.</p>
        <div class="welcomeShortcuts">
          ${localActions.slice(0, 3).map((action) => `<button data-action="${action.id}"><i data-lucide="${action.icon}"></i>${esc(action.title)}</button>`).join('')}
        </div>
      </div>
    </div>`;
}

function renderExpertWait(): string {
  return `
    <div class="expertWait" role="status" aria-label="Waiting for Diagnostic Expert">
      <div class="expertWaitVisual" aria-hidden="true">
        <div class="expertOrbit orbitOuter"><i></i><i></i><i></i></div>
        <div class="expertOrbit orbitInner"><i></i><i></i></div>
        <div class="expertSignal"><i data-lucide="Activity"></i><span></span></div>
      </div>
      <span class="eyebrow">EXPERT NETWORK</span>
      <h2>Finding your Diagnostic Expert</h2>
      <p>${esc(expertWaitMessage())}</p>
      <div class="expertWaitMeter" aria-hidden="true"><span></span></div>
    </div>`;
}

function renderConversation(): string {
  const turns = [...state.turns.values()].sort((left, right) => left.sequence - right.sequence);
  return turns.map((turn, index) => `
    <article class="turn" data-turn-sequence="${turn.sequence}">
      <div class="message userMessage">
        <div class="messageLabel">YOU</div>
        <div class="messageBody">${esc(turn.userText)}</div>
      </div>
      <div class="message assistantMessage ${turn.complete ? '' : 'active'}">
        <div class="assistantAvatar"><i data-lucide="Activity"></i></div>
        <div class="assistantContent">
          <div class="messageLabel">DIAGNOSTIC EXPERT</div>
          ${index === turns.length - 1 && state.localScan ? renderLocalScan(state.localScan) : ''}
          <div class="messageBody markdownBody">${turn.failed
            ? `<span class="failedText">${esc(turn.error ?? 'The diagnosis could not be completed.')}</span>`
            : turn.assistantText
              ? formatAssistantText(turn.assistantText)
              : '<span class="thinking"><i></i><i></i><i></i> Building a diagnostic plan</span>'}</div>
        </div>
      </div>
    </article>`).join('');
}

function renderLocalScan(scan: LocalScan): string {
  const stages = ['Understand', 'Permission', 'Check', 'Results'];
  return `
    <section class="localScanCard" data-stage="${scan.stage}">
      <div class="scanCardTopline"><span><i data-lucide="shield-check"></i> DEVICE DIAGNOSTIC</span><strong>${localScanStageLabel(scan.stage)}</strong></div>
      <div class="scanMonitorHero">
        <div class="scanCore"><i data-lucide="Activity"></i><span></span><span></span></div>
        <div><strong>${esc(scan.title)}</strong><p>${esc(localScanDetail(scan.stage))}</p></div>
      </div>
      <div class="scanPipeline">
        ${stages.map((label, index) => `<div class="scanStep ${localScanStepClass(scan.stage, index)}"><i></i><span>${label}</span></div>`).join('')}
      </div>
    </section>`;
}

function renderApproval(approval: PendingApproval): string {
  return `
    <div class="modalBackdrop" role="presentation">
      <section class="approvalPanel" role="dialog" aria-modal="true" aria-labelledby="approvalTitle">
        <div class="approvalTopline"><span>LOCAL ACCESS REQUEST</span><span>01</span></div>
        <div class="approvalHero">
          <div class="shieldVisual"><i data-lucide="shield-check"></i><span></span></div>
          <div>
            <h2 id="approvalTitle">Allow this diagnosis?</h2>
            <p>SignalOS needs permission to run read-only health checks on this device.</p>
          </div>
        </div>
        <div class="permissionPromise">
          <div><i data-lucide="Check"></i><span><strong>Read-only checks</strong><small>Inspect health signals without changing your device.</small></span></div>
          <div><i data-lucide="Check"></i><span><strong>This case only</strong><small>Access ends when you start a new case or close this page.</small></span></div>
        </div>
        <div class="approvalScope">
          <i data-lucide="shield-check"></i>
          <span>Approve once to keep this diagnosis moving without repeated prompts.</span>
        </div>
        <div class="approvalActions">
          <button id="denyApproval" class="secondaryButton" ${approval.submitting ? 'disabled' : ''}>Not now</button>
          <button id="grantApproval" class="grantButton" ${approval.submitting ? 'disabled' : ''}>
            <i data-lucide="shield-check"></i>${approval.submitting ? 'Authorizing…' : 'Allow this diagnosis'}
          </button>
        </div>
      </section>
    </div>`;
}

function renderSettings(): string {
  return `
    <div class="modalBackdrop settingsBackdrop" role="presentation">
      <section class="settingsPanel" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
        <div class="settingsTitle"><div><span>CONNECTION</span><h2 id="settingsTitle">Service endpoint</h2></div><button id="closeSettings" class="iconButton" aria-label="Close settings"><i data-lucide="X"></i></button></div>
        <label>Central URL<input id="centralUrl" type="url" value="${esc(state.centralUrl)}" /></label>
        <label>Tenant<input id="tenantId" value="${esc(state.tenantId)}" /></label>
        <p>Changing the endpoint reloads this page and starts a new case.</p>
        <button id="saveSettings" class="grantButton">Save & reconnect</button>
      </section>
    </div>`;
}

function bindEvents(): void {
  document.querySelector<HTMLElement>('#conversation')?.addEventListener('scroll', (event) => {
    const conversation = event.currentTarget as HTMLElement;
    conversationScrollTop = conversation.scrollTop;
    followConversationTail = isNearConversationTail(conversation);
  }, { passive: true });
  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
    button.addEventListener('click', () => {
      const action = [...localActions, ...generalActions].find((candidate) => candidate.id === button.dataset.action);
      if (action) void sendMessage(action.prompt, action);
    });
  });
  document.querySelector<HTMLFormElement>('#composer')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.querySelector<HTMLTextAreaElement>('#messageInput');
    const message = input?.value.trim();
    if (message) void sendMessage(message);
  });
  document.querySelector<HTMLTextAreaElement>('#messageInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      const input = event.currentTarget as HTMLTextAreaElement;
      const message = input.value.trim();
      if (message) void sendMessage(message);
    }
  });
  document.querySelector<HTMLTextAreaElement>('#messageInput')?.addEventListener('input', (event) => {
    const input = event.currentTarget as HTMLTextAreaElement;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
  });
  document.querySelector('#newSession')?.addEventListener('click', () => void newSession());
  document.querySelector('#settingsButton')?.addEventListener('click', () => { state.settingsOpen = true; render(); });
  document.querySelector('#closeSettings')?.addEventListener('click', () => { state.settingsOpen = false; render(); });
  document.querySelector('#saveSettings')?.addEventListener('click', saveSettings);
  document.querySelector('#dismissError')?.addEventListener('click', () => { state.error = ''; render(); });
  document.querySelector('#grantApproval')?.addEventListener('click', () => void grantSessionApproval());
  document.querySelector('#denyApproval')?.addEventListener('click', () => void denyCurrentApproval());
}

async function sendMessage(message: string, action?: DiagnosticAction): Promise<void> {
  if (!state.client || state.sending) return;
  followConversationTail = true;
  state.localScan = undefined;
  if (action?.local) {
    state.localScan = { actionId: action.id, title: action.title, detail: action.detail, stage: 'requested' };
  }
  state.sending = true;
  state.error = '';
  render();
  try {
    if (!state.session) {
      const result = await state.client.sessions.start({
        agent: AGENT_SPEC_ID,
        displayName: 'System diagnosis',
        workspace: { source: 'empty' }
      });
      state.session = result.session;
      state.sessionStatus = 'created';
      const ready = attachObserver(result.session);
      render();
      await ready;
      const turn = await result.session.send({ message });
      const conversationTurn = state.turns.get(turn.sequence) ?? emptyTurn(turn.sequence);
      conversationTurn.userText = message;
      state.turns.set(turn.sequence, conversationTurn);
    } else {
      const turn = await state.session.send({ message });
      state.turns.set(turn.sequence, emptyTurn(turn.sequence, message));
    }
  } catch (error) {
    state.error = errorMessage(error);
  } finally {
    state.sending = false;
    render();
  }
}

function attachObserver(session: SessionHandle): Promise<void> {
  state.observeAbort?.abort();
  const controller = new AbortController();
  state.observeAbort = controller;
  return new Promise<void>((resolve, reject) => {
    let ready = false;
    const timeout = window.setTimeout(() => {
      controller.abort();
      reject(new Error('Diagnostic Expert did not become ready within 3 minutes'));
    }, 180_000);
    controller.signal.addEventListener('abort', () => {
      window.clearTimeout(timeout);
      if (!ready) reject(new Error('Diagnostic case startup was cancelled'));
    }, { once: true });
    void (async () => {
      try {
        for await (const event of session.observe({ signal: controller.signal })) {
          applySessionEvent(event);
          if (event.type === 'status' && event.status === 'running' && !ready) {
            ready = true;
            window.clearTimeout(timeout);
            resolve();
          }
          if (event.type === 'status' && (event.status === 'failed' || event.status === 'cancelled') && !ready) {
            window.clearTimeout(timeout);
            reject(new Error(`Diagnostic Expert became ${event.status} before it was ready`));
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          state.error = errorMessage(error);
          scheduleRender();
          if (!ready) {
            window.clearTimeout(timeout);
            reject(error);
          }
        }
      }
    })();
  });
}

function applySessionEvent(event: SessionEvent): void {
  let needsRender = true;
  switch (event.type) {
    case 'user.message':
      turnFor(event.turnSeq).userText = event.text;
      break;
    case 'assistant.delta':
      updateStreamingAssistantText(event.turnSeq, event.text);
      needsRender = false;
      break;
    case 'turn.completed': {
      const turn = turnFor(event.turnSeq);
      if (!turn.assistantText && event.result.message) turn.assistantText = event.result.message;
      turn.complete = true;
      if (state.localScan && !['complete', 'failed'].includes(state.localScan.stage)) state.localScan.stage = 'complete';
      break;
    }
    case 'turn.failed': {
      const turn = turnFor(event.turnSeq);
      turn.failed = true;
      turn.complete = true;
      turn.error = event.error.message;
      if (state.localScan && state.localScan.stage !== 'complete') state.localScan.stage = 'failed';
      break;
    }
    case 'status':
      state.sessionStatus = event.status;
      break;
    case 'agent.progress':
      break;
    case 'tool.started':
      if (event.toolName === 'inspect_local_system') {
        ensureLocalScan().stage = 'delegating';
      }
      break;
    case 'tool.completed':
      if (event.toolName === 'inspect_local_system') {
        ensureLocalScan().stage = 'evidence_ready';
      }
      break;
    case 'interaction.requested':
      if (event.kind === 'approval' && !state.approvals.has(event.interactionId)) {
        if (event.source?.agentSpecId !== 'local-diagnostic') {
          void (isWebFetchApproval(event.request)
            ? approveWebFetchInteraction(event.interactionId)
            : denyNonDeviceInteraction(event.interactionId));
          break;
        }
        state.approvals.set(event.interactionId, { interactionId: event.interactionId, submitting: false });
        if (state.localScan) state.localScan.stage = state.trustedForSession ? 'authorized' : 'awaiting_approval';
        if (state.trustedForSession) void approveInteraction(event.interactionId);
      }
      break;
    case 'interaction.responded':
      if (state.localScan && state.localScan.stage !== 'failed') state.localScan.stage = 'scanning';
      state.approvals.delete(event.interactionId);
      break;
    case 'interaction.interrupted':
      state.approvals.delete(event.interactionId);
      break;
    case 'agent.internal':
      break;
  }
  if (needsRender) scheduleRender();
}

function updateStreamingAssistantText(turnSequence: number, delta: string): void {
  const turn = turnFor(turnSequence);
  turn.assistantText += delta;
  const conversation = document.querySelector<HTMLElement>('#conversation');
  const shouldFollow = conversation ? isNearConversationTail(conversation) : followConversationTail;
  const messageBody = document.querySelector<HTMLElement>(`[data-turn-sequence="${turnSequence}"] .assistantContent .messageBody`);
  if (!messageBody) {
    scheduleRender();
    return;
  }
  messageBody.innerHTML = formatAssistantText(turn.assistantText);
  if (conversation && shouldFollow) {
    conversation.scrollTop = conversation.scrollHeight;
    conversationScrollTop = conversation.scrollTop;
    followConversationTail = true;
  }
}

async function grantSessionApproval(): Promise<void> {
  state.trustedForSession = true;
  if (state.localScan) state.localScan.stage = 'authorized';
  render();
  await Promise.all([...state.approvals.keys()].map(approveInteraction));
}

async function approveInteraction(interactionId: string): Promise<void> {
  const approval = state.approvals.get(interactionId);
  if (!approval || !state.session || approval.submitting) return;
  approval.submitting = true;
  scheduleRender();
  try {
    await state.session.respondToInteraction({ interactionId, decision: 'approved', scope: 'once' });
    state.approvals.delete(interactionId);
    if (state.localScan) state.localScan.stage = 'scanning';
  } catch (error) {
    approval.submitting = false;
    state.error = errorMessage(error);
  }
  scheduleRender();
}

async function denyNonDeviceInteraction(interactionId: string): Promise<void> {
  if (!state.session) return;
  try {
    await state.session.respondToInteraction({ interactionId, decision: 'denied', scope: 'once' });
  } catch (error) {
    state.error = errorMessage(error);
    scheduleRender();
  }
}

async function approveWebFetchInteraction(interactionId: string): Promise<void> {
  if (!state.session) return;
  try {
    await state.session.respondToInteraction({ interactionId, decision: 'approved', scope: 'once' });
  } catch (error) {
    state.error = errorMessage(error);
    scheduleRender();
  }
}

function isWebFetchApproval(request: unknown): boolean {
  return request !== null
    && typeof request === 'object'
    && !Array.isArray(request)
    && (request as Record<string, unknown>).kind === 'url';
}

async function denyCurrentApproval(): Promise<void> {
  const approval = [...state.approvals.values()][0];
  if (!approval || !state.session || approval.submitting) return;
  approval.submitting = true;
  render();
  try {
    await state.session.respondToInteraction({ interactionId: approval.interactionId, decision: 'denied', scope: 'once' });
    state.approvals.delete(approval.interactionId);
    if (state.localScan) state.localScan.stage = 'failed';
  } catch (error) {
    approval.submitting = false;
    state.error = errorMessage(error);
  }
  render();
}

async function newSession(): Promise<void> {
  if (hasActiveDiagnosis()) return;
  const previous = state.session;
  state.observeAbort?.abort();
  state.observeAbort = undefined;
  state.session = undefined;
  state.sessionStatus = 'unknown';
  state.turns.clear();
  state.localScan = undefined;
  state.approvals.clear();
  state.trustedForSession = false;
  state.error = '';
  conversationScrollTop = 0;
  followConversationTail = true;
  render();
  if (previous) await previous.pause().catch(() => undefined);
}

function hasActiveDiagnosis(): boolean {
  const canBeActive = state.sessionStatus === 'created'
    || state.sessionStatus === 'queued'
    || state.sessionStatus === 'starting'
    || state.sessionStatus === 'running'
    || state.sessionStatus === 'resuming';
  return canBeActive && [...state.turns.values()].some((turn) => !turn.complete);
}

function saveSettings(): void {
  const centralUrl = document.querySelector<HTMLInputElement>('#centralUrl')?.value.trim();
  const tenantId = document.querySelector<HTMLInputElement>('#tenantId')?.value.trim();
  if (!centralUrl || !tenantId) return;
  localStorage.setItem('signalos.centralUrl', centralUrl.replace(/\/$/, ''));
  const params = new URLSearchParams(location.search);
  params.set('central', centralUrl.replace(/\/$/, ''));
  params.set('tenant', tenantId);
  location.href = `${location.pathname}?${params.toString()}${location.hash}`;
}

function syncShareableConnectionUrl(): void {
  const url = new URL(location.href);
  url.searchParams.set('central', state.centralUrl);
  url.searchParams.set('tenant', state.tenantId);
  history.replaceState(null, '', url);
}

function emptyTurn(sequence: number, userText = ''): ConversationTurn {
  return { sequence, userText, assistantText: '', complete: false, failed: false };
}

function turnFor(sequence: number): ConversationTurn {
  const existing = state.turns.get(sequence);
  if (existing) return existing;
  const turn = emptyTurn(sequence);
  state.turns.set(sequence, turn);
  return turn;
}

function ensureLocalScan(): LocalScan {
  state.localScan ??= {
    actionId: 'custom-local-scan',
    title: 'Custom local inspection',
    detail: 'Evidence requested by Diagnostic Expert',
    stage: 'requested'
  };
  return state.localScan;
}

function localScanStageLabel(stage: LocalScanStage): string {
  const labels: Record<LocalScanStage, string> = {
    requested: 'PREPARING', delegating: 'CONNECTING', awaiting_approval: 'APPROVAL NEEDED', authorized: 'APPROVED',
    scanning: 'CHECKING DEVICE', evidence_ready: 'REVIEWING RESULTS', complete: 'COMPLETE', failed: 'INTERRUPTED'
  };
  return labels[stage];
}

function localScanDetail(stage: LocalScanStage): string {
  const details: Record<LocalScanStage, string> = {
    requested: 'Choosing the smallest useful set of safe checks.',
    delegating: 'Establishing a secure connection to this device.',
    awaiting_approval: 'Your approval is needed before the device check can begin.',
    authorized: 'Access granted. Preparing the read-only checks.',
    scanning: 'Collecting health signals from this device.',
    evidence_ready: 'Reviewing the device signals and preparing your diagnosis.',
    complete: 'Device evidence has been included in the diagnosis.',
    failed: 'The device check stopped before results were available.'
  };
  return details[stage];
}

function localScanStepClass(stage: LocalScanStage, step: number): string {
  if (stage === 'failed') return step === 0 ? 'failed' : '';
  const activeStep: Record<LocalScanStage, number> = {
    requested: 0, delegating: 1, awaiting_approval: 2, authorized: 2, scanning: 2,
    evidence_ready: 3, complete: 4, failed: 0
  };
  const current = activeStep[stage];
  return step < current ? 'done' : step === current ? 'active' : '';
}

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function hydrateIcons(): void {
  createIcons({
    icons: {
      Activity, ArrowRight, Check, ChevronRight, CircleHelp, Clock3, Cpu, Gauge, HardDrive,
      Network, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, TriangleAlert, X
    },
    attrs: { 'stroke-width': 1.8 }
  });
}

function connectionLabel(): string {
  if (state.connection === 'connecting') return 'Connecting';
  if (state.connection === 'error') return 'Offline';
  return 'Service online';
}

function sessionStatusLabel(): string {
  if (state.sending) return 'Dispatching';
  if (!state.session) return 'Ready';
  if (state.sessionStatus === 'running' && [...state.turns.values()].some((turn) => !turn.complete)) return 'Analyzing';
  const labels: Partial<Record<SessionStatus, string>> = {
    created: 'Opening case', queued: 'Expert queued', starting: 'Expert starting', running: 'Expert ready',
    pausing: 'Pausing', paused: 'Paused', resuming: 'Resuming', completed: 'Complete', failed: 'Needs attention'
  };
  return labels[state.sessionStatus] ?? 'Connected';
}

function isWaitingForExpert(): boolean {
  return state.session !== undefined
    && (state.sessionStatus === 'created'
      || state.sessionStatus === 'queued'
      || state.sessionStatus === 'starting'
      || state.sessionStatus === 'resuming');
}

function expertWaitMessage(): string {
  const messages: Partial<Record<SessionStatus, string>> = {
    created: 'Opening a secure diagnostic channel.',
    queued: 'Your request is queued for the next available expert.',
    starting: 'An expert is joining and preparing the diagnostic workspace.',
    resuming: 'Reconnecting your expert to this case.'
  };
  return messages[state.sessionStatus] ?? 'Preparing your diagnostic session.';
}

function formatAssistantText(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, {
    async: false,
    breaks: true,
    gfm: true
  }));
}

function readCentralUrl(): string {
  const params = new URLSearchParams(location.search);
  return (params.get('central') ?? localStorage.getItem('signalos.centralUrl') ?? 'http://localhost:3000').replace(/\/$/, '');
}

function shortSessionId(value: string): string {
  return `CASE ${value.slice(0, 8).toUpperCase()}`;
}

function captureConversationScroll(): void {
  const conversation = document.querySelector<HTMLElement>('#conversation');
  if (!conversation) return;
  conversationScrollTop = conversation.scrollTop;
  followConversationTail = isNearConversationTail(conversation);
}

function restoreConversationScroll(): void {
  const conversation = document.querySelector<HTMLElement>('#conversation');
  if (!conversation) return;
  conversation.scrollTop = followConversationTail
    ? conversation.scrollHeight
    : Math.min(conversationScrollTop, Math.max(0, conversation.scrollHeight - conversation.clientHeight));
  conversationScrollTop = conversation.scrollTop;
}

function isNearConversationTail(conversation: HTMLElement): boolean {
  return conversation.scrollHeight - conversation.clientHeight - conversation.scrollTop <= 48;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}