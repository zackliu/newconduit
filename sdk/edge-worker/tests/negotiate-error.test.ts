import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EdgeWorkerRuntime,
  type EdgeAgent,
  type EdgeTurnResult,
  type EdgeWorkerSubscription,
  type EdgeWorkerTransport
} from '../src/index';

/**
 * Browser peer of the sidecar negotiate-propagation test. When central rejects a worker registration, the
 * edge SDK's public `register()` must surface central's sanitized error body so the Device Scan UI can show
 * *why* it could not join, instead of an opaque status code. The transport/agent are never reached on a
 * failed negotiate; they throw if that assumption breaks.
 */
class UnusedTransport implements EdgeWorkerTransport {
  async connect(): Promise<void> {
    throw new Error('transport.connect must not run when negotiate fails');
  }
  async publish(): Promise<void> {
    throw new Error('transport.publish must not run when negotiate fails');
  }
  async subscribe(): Promise<EdgeWorkerSubscription> {
    throw new Error('transport.subscribe must not run when negotiate fails');
  }
  async stop(): Promise<void> {}
}

const UNUSED_AGENT: EdgeAgent = {
  async runTurn(): Promise<EdgeTurnResult> {
    throw new Error('agent.runTurn must not run when negotiate fails');
  }
};

const REGISTRATION = {
  centralUrl: 'http://central.invalid',
  tenantId: 'poc',
  storageClass: 'host-managed',
  labels: { agent: 'browser-edge', storage: 'host-managed' },
  capacity: 1
};

async function withStubbedFetch(next: Response, body: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => next) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

test('edge worker register surfaces central\'s structured error body, not just the status', async () => {
  const response = new Response(JSON.stringify({ error: 'invalid sidecar registration body' }), {
    status: 400,
    headers: { 'content-type': 'application/json' }
  });
  await withStubbedFetch(response, async () => {
    const runtime = new EdgeWorkerRuntime({ transport: new UnusedTransport(), agent: UNUSED_AGENT });
    await assert.rejects(
      runtime.register(REGISTRATION),
      (error: Error) => {
        assert.match(error.message, /HTTP 400/);
        assert.match(error.message, /invalid sidecar registration body/);
        return true;
      }
    );
  });
});

test('edge worker register redacts a token-like value in the error body', async () => {
  const response = new Response('upstream rejected https://wps.example.com/hub?access_token=SUPER_SECRET_TOKEN', {
    status: 500
  });
  await withStubbedFetch(response, async () => {
    const runtime = new EdgeWorkerRuntime({ transport: new UnusedTransport(), agent: UNUSED_AGENT });
    await assert.rejects(
      runtime.register(REGISTRATION),
      (error: Error) => {
        assert.doesNotMatch(error.message, /SUPER_SECRET_TOKEN/);
        assert.match(error.message, /access_token=\[redacted\]/);
        return true;
      }
    );
  });
});
