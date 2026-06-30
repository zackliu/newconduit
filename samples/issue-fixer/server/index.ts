import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.ISSUE_FIXER_API_PORT ?? '8788');
const CLIENT_ID = process.env.ISSUE_FIXER_GITHUB_CLIENT_ID ?? '';
const OAUTH_SCOPE = 'public_repo read:user';
const GH = { 'user-agent': 'agent-runtime-issue-fixer', accept: 'application/vnd.github+json' };

interface UserSession {
  token: string;
  login: string;
  deviceCode?: string;
  interval: number;
}

const sessions = new Map<string, UserSession>();

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie ?? '';
  return Object.fromEntries(
    header.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
    })
  );
}

function getSession(req: IncomingMessage, res: ServerResponse): UserSession {
  const sid = parseCookies(req).sid;
  if (sid && sessions.has(sid)) return sessions.get(sid)!;
  const next = randomUUID();
  const session: UserSession = { token: '', login: '', interval: 5 };
  sessions.set(next, session);
  res.setHeader('Set-Cookie', `sid=${next}; HttpOnly; SameSite=Lax; Path=/`);
  return session;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const session = getSession(req, res);

  if (url.pathname === '/api/login/start') {
    if (!CLIENT_ID) { sendJson(res, 200, { needsClientId: true }); return; }
    const r = await fetch('https://github.com/login/device/code', {
      method: 'POST', headers: { ...GH, 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: OAUTH_SCOPE })
    });
    const d = (await r.json()) as { device_code: string; user_code: string; verification_uri: string; interval: number };
    session.deviceCode = d.device_code;
    session.interval = d.interval ?? 5;
    sendJson(res, 200, { userCode: d.user_code, verificationUri: d.verification_uri, interval: session.interval });
    return;
  }

  if (url.pathname === '/api/login/poll') {
    if (!session.deviceCode) { sendJson(res, 400, { status: 'no_device' }); return; }
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { ...GH, 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: session.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    });
    const d = (await r.json()) as { access_token?: string; error?: string };
    if (d.access_token) {
      session.token = d.access_token;
      session.deviceCode = undefined;
      const me = await fetch('https://api.github.com/user', { headers: { ...GH, authorization: `Bearer ${d.access_token}` } });
      session.login = ((await me.json()) as { login?: string }).login ?? 'github-user';
      sendJson(res, 200, { status: 'ok', login: session.login });
      return;
    }
    sendJson(res, 200, { status: d.error ?? 'authorization_pending', interval: session.interval });
    return;
  }

  if (url.pathname === '/api/me') { sendJson(res, 200, { login: session.login || null }); return; }
  if (url.pathname === '/api/logout') { session.token = ''; session.login = ''; sendJson(res, 200, { ok: true }); return; }

  if (url.pathname === '/api/issues') {
    const repo = url.searchParams.get('repo') ?? '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { sendJson(res, 400, { error: 'repo must be owner/name' }); return; }
    const headers = session.token ? { ...GH, authorization: `Bearer ${session.token}` } : GH;
    const r = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=30`, { headers });
    if (!r.ok) { sendJson(res, r.status, { error: `github ${r.status}${session.token ? '' : ' — sign in for higher rate / private repos'}` }); return; }
    const raw = (await r.json()) as Array<{ number: number; title: string; body?: string; pull_request?: unknown }>;
    sendJson(res, 200, { issues: raw.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, body: (i.body ?? '').slice(0, 4000) })) });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

createServer((req, res) => {
  handle(req, res).catch((e) => sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) }));
}).listen(PORT, () => console.log(`issue-fixer api on http://127.0.0.1:${PORT} (device-flow ${CLIENT_ID ? 'enabled' : 'anonymous public-only'})`));
