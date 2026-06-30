import { AgentRuntimeClient, type SessionEvent, type SessionHandle } from '@agent-runtime-sidecar/sdk';

interface Issue {
  number: number;
  title: string;
  body: string;
}

interface TraceLine {
  kind: 'progress' | 'tool' | 'assistant' | 'status';
  text: string;
}

interface IssueWork {
  issue: Issue;
  session?: SessionHandle;
  trace: TraceLine[];
  status: string;
  working: boolean;
  error: string;
}

const DOTNET_AGENT_SPEC = 'dotnet-poc';

const state = {
  login: null as string | null,
  centralUrl: localStorage.getItem('fixer.centralUrl') ?? 'http://localhost:3000',
  tenantId: localStorage.getItem('fixer.tenantId') ?? 'poc',
  repo: localStorage.getItem('fixer.repo') ?? 'Azure/azure-signalr',
  issues: [] as Issue[],
  works: new Map<number, IssueWork>(),
  activeIssueNumber: undefined as number | undefined,
  device: undefined as { userCode: string; verificationUri: string } | undefined,
  error: ''
};

let clientPromise: Promise<AgentRuntimeClient> | undefined;

const root = document.querySelector<HTMLDivElement>('#app')!;
void boot();

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  if (params.get('error')) {
    state.error = `GitHub sign-in failed: ${params.get('error')}`;
    history.replaceState({}, '', '/');
  }
  const me = await fetch('/api/me').then((r) => r.json()).catch(() => ({ login: null }));
  state.login = me.login;
  render();
}

function render(): void {
  root.innerHTML = `
    <main class="shell">
      <header class="top">
        <div class="brand"><span class="mark">⌁</span> Issue Fixer <small>on Agent Runtime Sidecar</small></div>
        <div class="who">${state.login ? `@${esc(state.login)} · <button id="logout" class="link">sign out</button>` : `<button id="login" class="link">Sign in with GitHub (optional)</button>`}</div>
      </header>

      ${state.device ? `<div class="device">Enter code <b>${esc(state.device.userCode)}</b> at <a href="${esc(state.device.verificationUri)}" target="_blank">${esc(state.device.verificationUri)}</a> — waiting for approval…</div>` : ''}

      <section class="repoBar">
        <input id="repo" value="${esc(state.repo)}" placeholder="owner/name" />
        <button id="loadIssues" class="primary">List issues</button>
        <span class="agentTag">agent: ${DOTNET_AGENT_SPEC} · .NET 8/9 worker pool</span>
      </section>

      <div class="cols">
        <section class="issues">
          ${state.issues.map((i) => {
            const w = state.works.get(i.number);
            const dot = w?.working ? '<span class="dot busy"></span>'
              : w && (w.status === 'completed' || w.status === 'failed') ? `<span class="dot ${w.status}"></span>`
              : '';
            return `
            <button class="issue ${state.activeIssueNumber === i.number ? 'on' : ''}" data-n="${i.number}">
              <span class="num">#${i.number}</span><span class="t">${esc(i.title)}</span>${dot}
            </button>`;
          }).join('') || `<p class="empty">${state.login ? 'Pick a repo and list its issues.' : 'List public issues, or sign in for private repos.'}</p>`}
        </section>

        <section class="work">
          ${renderWork()}
          ${state.error ? `<div class="err">${esc(state.error)}</div>` : ''}
        </section>
      </div>
    </main>`;

  document.querySelector('#login')?.addEventListener('click', () => void startLogin());
  document.querySelector('#logout')?.addEventListener('click', () => { void fetch('/api/logout').then(() => { state.login = null; render(); }); });
  document.querySelector('#repo')?.addEventListener('input', (e) => { state.repo = (e.target as HTMLInputElement).value.trim(); localStorage.setItem('fixer.repo', state.repo); });
  document.querySelector('#loadIssues')?.addEventListener('click', () => void loadIssues());
  document.querySelectorAll<HTMLButtonElement>('.issue').forEach((b) => b.addEventListener('click', () => selectIssue(Number(b.dataset.n))));
  document.querySelector<HTMLButtonElement>('#startWork')?.addEventListener('click', (e) => void startWork(Number((e.currentTarget as HTMLButtonElement).dataset.n)));
}

async function loadIssues(): Promise<void> {
  state.error = '';
  const res = await fetch(`/api/issues?repo=${encodeURIComponent(state.repo)}`);
  const body = await res.json();
  if (!res.ok) { state.error = body.error ?? 'failed to load issues'; render(); return; }
  state.issues = body.issues;
  state.works = new Map();
  state.activeIssueNumber = undefined;
  render();
}

async function startLogin(): Promise<void> {
  state.error = '';
  const body = await fetch('/api/login/start', { method: 'POST' }).then((r) => r.json());
  if (body.needsClientId) { state.error = 'sign-in disabled: set ISSUE_FIXER_GITHUB_CLIENT_ID; public repos still work'; render(); return; }
  state.device = { userCode: body.userCode, verificationUri: body.verificationUri };
  render();
  window.open(body.verificationUri, '_blank');
  void pollLogin((body.interval ?? 5) * 1000);
}

async function pollLogin(intervalMs: number): Promise<void> {
  const body = await fetch('/api/login/poll', { method: 'POST' }).then((r) => r.json());
  if (body.status === 'ok') { state.login = body.login; state.device = undefined; render(); return; }
  if (body.status === 'authorization_pending' || body.status === 'slow_down') {
    setTimeout(() => void pollLogin(intervalMs + (body.status === 'slow_down' ? 5000 : 0)), intervalMs);
    return;
  }
  state.device = undefined;
  state.error = `sign-in ${body.status}`;
  render();
}

function selectIssue(number: number): void {
  const issue = state.issues.find((i) => i.number === number);
  if (!issue) return;
  state.activeIssueNumber = number;
  if (!state.works.has(number)) {
    state.works.set(number, { issue, trace: [], status: 'idle', working: false, error: '' });
  }
  render();
}

function ensureClient(): Promise<AgentRuntimeClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new AgentRuntimeClient({ centralUrl: state.centralUrl, tenantId: state.tenantId });
      await client.connect();
      return client;
    })().catch((err) => {
      clientPromise = undefined;
      throw err;
    });
  }
  return clientPromise;
}

async function startWork(number: number): Promise<void> {
  const work = state.works.get(number);
  if (!work || work.status !== 'idle') return;
  work.status = 'dispatching';
  work.working = true;
  work.error = '';
  work.trace = [];
  render();
  try {
    const client = await ensureClient();
    const issue = work.issue;
    const prompt = `Clone https://github.com/${state.repo}, then fix issue #${issue.number}: "${issue.title}".\n\n${issue.body}\n\nWork in the repo, make the change, and run dotnet build to verify.`;
    const { session } = await client.sessions.start({ agent: DOTNET_AGENT_SPEC, workspace: { source: 'empty' } });
    work.session = session;
    work.status = 'queued';
    scheduleRender();
    let sent = false;
    for await (const ev of session.observe()) {
      applyEvent(work, ev);
      if (!sent && work.status === 'running') { sent = true; void session.send({ message: prompt }); }
      scheduleRender();
      if (work.status === 'completed' || work.status === 'failed') break;
    }
  } catch (err) {
    work.error = err instanceof Error ? err.message : String(err);
    work.status = 'failed';
  } finally {
    work.working = false;
    scheduleRender();
  }
}

function applyEvent(work: IssueWork, ev: SessionEvent): void {
  if (ev.type === 'status' && work.status !== 'completed' && work.status !== 'failed') work.status = ev.status === 'completed' || ev.status === 'failed' ? work.status : 'running';
  else if (ev.type === 'agent.progress') work.trace.push({ kind: 'progress', text: ev.message });
  else if (ev.type === 'tool.started') work.trace.push({ kind: 'tool', text: `\u25b6 ${ev.toolName}` });
  else if (ev.type === 'tool.completed') work.trace.push({ kind: 'tool', text: `\u2713 ${ev.toolName}` });
  else if (ev.type === 'assistant.delta') {
    const last = work.trace[work.trace.length - 1];
    if (last?.kind === 'assistant') last.text += ev.text; else work.trace.push({ kind: 'assistant', text: ev.text });
    work.status = 'running';
  } else if (ev.type === 'turn.completed') { work.status = 'completed'; if (ev.result.message) work.trace.push({ kind: 'status', text: ev.result.message }); }
  else if (ev.type === 'turn.failed') { work.status = 'failed'; work.error = ev.error.message; }
}

function renderWork(): string {
  if (state.activeIssueNumber === undefined) return '<p class="empty">Select an issue to see its details.</p>';
  const work = state.works.get(state.activeIssueNumber);
  if (!work) return '<p class="empty">Select an issue to see its details.</p>';
  const issue = work.issue;
  const started = work.status !== 'idle';
  return `
    <div class="issueHead"><b>#${issue.number}</b> ${esc(issue.title)} <span class="pill ${work.working ? 'busy' : ''}">${esc(work.status)}</span></div>
    <div class="issueBody">${renderBody(issue.body)}</div>
    ${started
      ? `<ol class="trace">${work.trace.map(traceRow).join('') || '<li class="muted">waiting for worker…</li>'}</ol>`
      : `<div class="startRow"><button id="startWork" class="primary" data-n="${issue.number}">Start work on it</button></div>`}
    ${work.error ? `<div class="err">${esc(work.error)}</div>` : ''}`;
}

function renderBody(body: string): string {
  const t = (body ?? '').trim();
  return t ? esc(t) : '<span class="muted">(no description)</span>';
}

function traceRow(l: TraceLine): string {
  return `<li class="tr ${l.kind}">${esc(l.text)}</li>`;
}

let scheduled = false;
function scheduleRender(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { scheduled = false; render(); });
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
