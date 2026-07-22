export type EdgeRole = 'console' | 'edge';

/**
 * A one-time pairing invite the operator console minted for this case. It is carried ONLY in the pair link's URL
 * fragment (`#pair=<inviteId>.<inviteSecret>`), never a query param, and is consumed + stripped from the URL on
 * load. The invite authorizes nothing by itself — the device redeems it once into a durable Central binding.
 */
export interface PairingInvite {
  inviteId: string;
  inviteSecret: string;
}

export interface DemoConfig {
  role: EdgeRole;
  centralUrl: string;
  tenantId: string;
  /** Console: the recovery case (parent session) to resume, if any. Never a routing secret. */
  sessionId: string | undefined;
  deviceLabel: string;
  /** Edge: a one-time invite read from the URL fragment on first open. Absent on reconnect. */
  invite: PairingInvite | undefined;
}

const STORAGE_PREFIX = 'rnr.edge';
const DEFAULT_CENTRAL_URL = 'http://localhost:3000';
const DEFAULT_TENANT = 'poc';

function stored(key: string): string | undefined {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}.${key}`) ?? undefined;
  } catch {
    return undefined;
  }
}

export function persist(key: string, value: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}.${key}`, value);
  } catch {
    /* private-mode browsers throw on write; the demo still works from query params */
  }
}

export function clearStored(key: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}.${key}`);
  } catch {
    /* ignore */
  }
}

function defaultDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS device';
  if (/android/i.test(ua)) return 'Android device';
  if (/mac os x/i.test(ua)) return 'macOS device';
  if (/windows/i.test(ua)) return 'Windows device';
  return 'Browser device';
}

/**
 * Read the one-time invite from the URL fragment (`#pair=<inviteId>.<inviteSecret>`) and immediately strip it via
 * `history.replaceState`, so the secret never lingers in the address bar, bookmarks, history, or a referrer. The
 * fragment is used because it is never sent to a server or logged as a query param.
 */
function consumeInviteFragment(): PairingInvite | undefined {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const params = new URLSearchParams(hash);
  const raw = params.get('pair');
  if (raw) {
    // Remove the fragment before anything else touches it.
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      /* ignore — still consume it below */
    }
    const dot = raw.indexOf('.');
    if (dot > 0) {
      const inviteId = raw.slice(0, dot);
      const inviteSecret = raw.slice(dot + 1);
      if (inviteId && inviteSecret) return { inviteId, inviteSecret };
    }
  }
  return undefined;
}

export function readConfig(): DemoConfig {
  const params = new URLSearchParams(location.search);
  const role = params.get('role') === 'edge' ? 'edge' : 'console';
  const centralUrl = params.get('central') ?? stored('centralUrl') ?? DEFAULT_CENTRAL_URL;
  const tenantId = params.get('tenant') ?? stored('tenantId') ?? DEFAULT_TENANT;
  const sessionId = params.get('session') ?? undefined;
  const deviceLabel = params.get('device') ?? stored('deviceLabel') ?? defaultDeviceLabel();
  const invite = role === 'edge' ? consumeInviteFragment() : undefined;
  return { role, centralUrl, tenantId, sessionId, deviceLabel, invite };
}

/**
 * Build the shareable Device Scan link for a freshly minted invite. Non-secret transport config (`central`,
 * `tenant`, `role`) stays in the query for demo convenience; the one-time invite is placed ONLY in the fragment.
 * No stable deviceId and no durable routing secret ever appears in this URL.
 */
export function buildEdgeInviteLink(input: {
  centralUrl: string;
  tenantId: string;
  invite: PairingInvite;
}): string {
  const url = new URL(location.origin + location.pathname);
  url.searchParams.set('role', 'edge');
  url.searchParams.set('central', input.centralUrl);
  url.searchParams.set('tenant', input.tenantId);
  url.hash = `pair=${input.invite.inviteId}.${input.invite.inviteSecret}`;
  return url.toString();
}
