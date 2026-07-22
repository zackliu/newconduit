import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SidecarDaemon } from '../../src/sidecar/sidecar-daemon';
import type { SidecarAgentProcessAdapter, SidecarAgentTurnResult, SidecarRuntimeTransport, SidecarWorkspaceAdapter, SidecarWorkspaceMount } from '../../src/sidecar/contracts';
import type { RuntimeSubscription, SnapshotPartName } from '../../src/shared';

/**
 * The reported bug: an untyped `.mjs` caller sent a malformed registration and only saw
 * `sidecar negotiate failed with HTTP 400`, hiding central's actual reason. These tests pin the public
 * `startStandaloneWorker` behaviour: on any non-2xx negotiate response it must surface central's sanitized
 * error body (never just the status), so the operator can see *why* registration was rejected — while never
 * leaking a credential-bearing token that might appear in a body.
 *
 * The negotiate HTTP call runs before any transport/workspace/agent work, so on a failed negotiate none of
 * these adapters are touched; they exist only to satisfy the constructor and throw if that assumption breaks.
 */
class UnusedTransport implements SidecarRuntimeTransport {
  async connect(): Promise<void> {
    throw new Error('transport.connect must not run when negotiate fails');
  }
  async publish(): Promise<void> {
    throw new Error('transport.publish must not run when negotiate fails');
  }
  async subscribe(): Promise<RuntimeSubscription> {
    throw new Error('transport.subscribe must not run when negotiate fails');
  }
  async stop(): Promise<void> {}
}

class UnusedWorkspace implements SidecarWorkspaceAdapter {
  mount(): SidecarWorkspaceMount {
    throw new Error('workspace.mount must not run when negotiate fails');
  }
  async capture(): Promise<SnapshotPartName[]> {
    throw new Error('workspace.capture must not run when negotiate fails');
  }
  async restore(): Promise<void> {}
}

class UnusedAgent implements SidecarAgentProcessAdapter {
  async start(): Promise<void> {}
  async send(): Promise<SidecarAgentTurnResult> {
    throw new Error('agent.send must not run when negotiate fails');
  }
}

function newDaemon(): SidecarDaemon {
  return new SidecarDaemon({
    runtimeTransport: new UnusedTransport(),
    workspaceAdapter: new UnusedWorkspace(),
    agentProcessAdapter: new UnusedAgent()
  });
}

const REGISTRATION = {
  centralUrl: 'http://central.invalid',
  tenantId: 'poc',
  storageClass: 'host-managed',
  labels: { agent: 'copilot', storage: 'host-managed' },
  capacity: 1,
  allocatable: 1
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

test('standalone worker negotiate surfaces central\'s structured error body, not just the status', async () => {
  const response = new Response(JSON.stringify({ error: 'invalid sidecar registration body' }), {
    status: 400,
    headers: { 'content-type': 'application/json' }
  });
  await withStubbedFetch(response, async () => {
    await assert.rejects(
      newDaemon().startStandaloneWorker(REGISTRATION),
      (error: Error) => {
        assert.match(error.message, /HTTP 400/);
        assert.match(error.message, /invalid sidecar registration body/);
        return true;
      }
    );
  });
});

test('standalone worker negotiate surfaces a non-JSON error body verbatim', async () => {
  const response = new Response('Bad Gateway', { status: 502 });
  await withStubbedFetch(response, async () => {
    await assert.rejects(
      newDaemon().startStandaloneWorker(REGISTRATION),
      (error: Error) => {
        assert.match(error.message, /HTTP 502/);
        assert.match(error.message, /Bad Gateway/);
        return true;
      }
    );
  });
});

test('standalone worker negotiate redacts a token-like value in the error body', async () => {
  const response = new Response('upstream rejected https://wps.example.com/hub?access_token=SUPER_SECRET_TOKEN', {
    status: 500
  });
  await withStubbedFetch(response, async () => {
    await assert.rejects(
      newDaemon().startStandaloneWorker(REGISTRATION),
      (error: Error) => {
        assert.doesNotMatch(error.message, /SUPER_SECRET_TOKEN/);
        assert.match(error.message, /access_token=\[redacted\]/);
        return true;
      }
    );
  });
});
