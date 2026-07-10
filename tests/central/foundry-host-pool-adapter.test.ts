import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccessToken, TokenCredential } from '@azure/identity';
import { FoundryHostPoolAdapter } from '../../src/central/adapters';
import type { HostPoolInstanceRecord, WorkerPoolRecord } from '../../src/shared';

const fakeCredential: TokenCredential = {
  async getToken(): Promise<AccessToken> {
    return { token: 'fake-token', expiresOnTimestamp: Date.now() + 3_600_000 };
  }
};

function makePool(): WorkerPoolRecord {
  return {
    poolId: 'foundry-copilot',
    tenantId: 'tenant-x',
    template: { labels: { agent: 'copilot', storage: 'host-managed' }, capacity: 1 },
    hostPoolControllerClass: 'foundry',
    scalePolicy: { scaleOutMaxPendingPerTick: 1, scaleInIdleMs: 5_000 },
    centralUrlForWorkers: 'http://central.example:3000'
  };
}

function makeInstance(overrides: Partial<HostPoolInstanceRecord> = {}): HostPoolInstanceRecord {
  const now = new Date().toISOString();
  return {
    instanceId: 'inst-1',
    tenantId: 'tenant-x',
    poolId: 'foundry-copilot',
    hostPoolControllerClass: 'foundry',
    labels: { agent: 'copilot', storage: 'host-managed' },
    capacity: 1,
    state: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

interface FakeFetch {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  invocationOpened: Promise<void>;
}

/**
 * Fake fetch that records calls and, for the held `/invocations` request, returns a Response whose body stays
 * open until the caller aborts - so the adapter's liveness loop stays in-flight exactly like the real platform.
 */
function makeFakeFetch(): FakeFetch {
  const calls: RecordedCall[] = [];
  let markOpened: () => void = () => {};
  const invocationOpened = new Promise<void>((resolve) => {
    markOpened = resolve;
  });
  const fetchImpl = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined
    });
    if (url.includes('/invocations')) {
      const signal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const close = (): void => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          };
          if (signal) {
            if (signal.aborted) {
              close();
              return;
            }
            signal.addEventListener('abort', close, { once: true });
          }
        }
      });
      markOpened();
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls, invocationOpened };
}

test('scenario: foundry scaleOut opens a held liveness invocation using a client-controlled agent_session_id', async () => {
  const { fetchImpl, calls, invocationOpened } = makeFakeFetch();
  const adapter = new FoundryHostPoolAdapter({
    projectEndpoint: 'https://acct.services.ai.azure.com/api/projects/proj/',
    agentName: 'ars',
    workerType: 'copilot-local',
    credential: fakeCredential,
    fetchImpl
  });
  const pool = makePool();
  const instance = makeInstance();

  const result = await adapter.scaleOut({ pool, instance });
  // an unpinned (shared) instance has no session workspaceRef, so it falls back to a per-instance client id
  assert.equal(result.containerId, 'w-inst-1');

  await invocationOpened;
  const post = calls.find((call) => call.url.includes('/invocations'));
  assert.ok(post, 'expected a POST to /invocations');
  // scaleOut normalizes any prior session state to a clean boot: it stops stale compute BEFORE invoking, so the
  // invocation always cold-boots a fresh container whose sidecar registers under this instance id.
  const stopBeforeInvoke = calls.findIndex((call) => call.method === 'POST' && call.url.includes('/stop'));
  const invokeIndex = calls.findIndex((call) => call.url.includes('/invocations'));
  assert.ok(stopBeforeInvoke >= 0, 'scaleOut should stop any stale compute before invoking');
  assert.ok(stopBeforeInvoke < invokeIndex, 'the stop must precede the invocation so the boot is always fresh');
  assert.equal(post.method, 'POST');
  // the client session id is carried in the agent_session_id query parameter (a request header is ignored)
  assert.equal(
    post.url,
    'https://acct.services.ai.azure.com/api/projects/proj/agents/ars/endpoint/protocols/invocations?api-version=v1&agent_session_id=w-inst-1'
  );
  assert.equal(post.headers.authorization, 'Bearer fake-token');
  assert.equal(post.headers['x-agent-session-id'], undefined);
  assert.equal(post.headers['foundry-features'], 'HostedAgents=V1Preview');
  assert.equal(post.headers['content-type'], 'application/json');

  const payload = JSON.parse(post.body ?? '{}') as Record<string, unknown>;
  assert.equal(payload.centralUrl, 'http://central.example:3000');
  assert.equal(payload.tenantId, 'tenant-x');
  assert.equal(payload.workerTypeId, 'copilot-local');
  assert.equal(payload.workerPoolId, 'foundry-copilot');
  assert.equal(payload.workerPoolInstanceId, 'inst-1');
  assert.deepEqual(payload.labels, { agent: 'copilot', storage: 'host-managed' });
  assert.equal(payload.capacity, 1);

  // release the held connection so the test does not leak a pending stream
  await adapter.scaleIn({ pool, instance: { ...instance, containerId: result.containerId } });
});

test('scenario: foundry scaleIn aborts the liveness request and deletes the session', async () => {
  const { fetchImpl, calls, invocationOpened } = makeFakeFetch();
  const adapter = new FoundryHostPoolAdapter({
    projectEndpoint: 'https://acct.services.ai.azure.com/api/projects/proj',
    agentName: 'ars',
    workerType: 'copilot-local',
    credential: fakeCredential,
    fetchImpl
  });
  const pool = makePool();
  const instance = makeInstance();

  const result = await adapter.scaleOut({ pool, instance });
  await invocationOpened;
  await adapter.scaleIn({ pool, instance: { ...instance, containerId: result.containerId } });

  const del = calls.find((call) => call.method === 'DELETE');
  assert.ok(del, 'expected a DELETE session call');
  assert.equal(
    del.url,
    'https://acct.services.ai.azure.com/api/projects/proj/agents/ars/endpoint/sessions/w-inst-1?api-version=v1'
  );
  assert.equal(del.headers.authorization, 'Bearer fake-token');
});

test('scenario: foundry scaleIn deletes by recorded container id when central has no in-memory handle', async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const adapter = new FoundryHostPoolAdapter({
    projectEndpoint: 'https://acct.services.ai.azure.com/api/projects/proj',
    agentName: 'ars',
    workerType: 'copilot-local',
    credential: fakeCredential,
    fetchImpl
  });
  const pool = makePool();

  // no prior scaleOut on this adapter instance (e.g. central restarted); scaleIn still deletes by the recorded
  // client session id stored as containerId
  await adapter.scaleIn({ pool, instance: makeInstance({ containerId: 'w-inst-9' }) });

  const del = calls.find((call) => call.method === 'DELETE');
  assert.ok(del);
  assert.ok(del.url.includes('/endpoint/sessions/w-inst-9?api-version=v1'));
});

test('scenario: foundry scaleOut keys the durable session on the pinned session workspaceRef so a resume reaches the same sandbox', async () => {
  const { fetchImpl, calls, invocationOpened } = makeFakeFetch();
  const adapter = new FoundryHostPoolAdapter({
    projectEndpoint: 'https://acct.services.ai.azure.com/api/projects/proj',
    agentName: 'ars',
    workerType: 'copilot-local',
    credential: fakeCredential,
    fetchImpl
  });
  const pool = makePool();
  // a no-reuse pool pins the instance to its session; the durable Foundry session id is that session's stable
  // workspaceRef (not the ephemeral instanceId), so a fresh instance on resume re-invokes the same sandbox.
  const instance = makeInstance({ boundSessionId: 'sess-1', workspaceRef: 'ws-abc-123' });

  const result = await adapter.scaleOut({ pool, instance });
  assert.equal(result.containerId, 'ws-abc-123');

  await invocationOpened;
  const post = calls.find((call) => call.url.includes('/invocations'));
  assert.ok(post);
  assert.ok(post.url.endsWith('agent_session_id=ws-abc-123'), post.url);

  await adapter.scaleIn({ pool, instance: { ...instance, containerId: result.containerId }, durableAction: 'release' });
});

test('scenario: foundry scaleIn stops (not deletes) the durable session on pause and deletes it only on release', async () => {
  const { fetchImpl, calls, invocationOpened } = makeFakeFetch();
  const adapter = new FoundryHostPoolAdapter({
    projectEndpoint: 'https://acct.services.ai.azure.com/api/projects/proj',
    agentName: 'ars',
    workerType: 'copilot-local',
    credential: fakeCredential,
    fetchImpl
  });
  const pool = makePool();
  const instance = makeInstance({ boundSessionId: 'sess-1', workspaceRef: 'ws-abc-123' });

  const result = await adapter.scaleOut({ pool, instance });
  await invocationOpened;
  const callsBeforePause = calls.length;

  // pause: stop compute (abort the held request + stop the container) but keep the session record + $HOME, so a
  // resume re-invokes the same sandbox. Stopping - not merely aborting - is what leaves the session cleanly
  // inactive; a still-warm container would keep its boot-once sidecar and the resume would never correlate.
  await adapter.scaleIn({ pool, instance: { ...instance, containerId: result.containerId }, durableAction: 'retain' });
  const pauseCalls = calls.slice(callsBeforePause);
  const stopCall = pauseCalls.find((call) => call.method === 'POST' && call.url.includes('/stop'));
  assert.ok(stopCall, 'retain must stop the Foundry compute so a resume cold-boots a fresh container');
  assert.ok(stopCall.url.includes('/endpoint/sessions/ws-abc-123/stop?api-version=v1'), stopCall.url);
  assert.equal(pauseCalls.find((call) => call.method === 'DELETE'), undefined, 'retain must not delete the Foundry session');

  // session ended: release deletes the durable session by its workspaceRef
  await adapter.scaleIn({ pool, instance: { ...instance, containerId: result.containerId }, durableAction: 'release' });
  const del = calls.find((call) => call.method === 'DELETE');
  assert.ok(del, 'release must delete the Foundry session');
  assert.ok(del.url.includes('/endpoint/sessions/ws-abc-123?api-version=v1'), del.url);
});
