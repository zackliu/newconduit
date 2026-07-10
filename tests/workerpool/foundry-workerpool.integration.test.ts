import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DefaultAzureCredential } from '@azure/identity';
import { FoundryHostPoolAdapter } from '../../src/central/adapters';
import type { HostPoolInstanceRecord, WorkerPoolRecord } from '../../src/shared';
import { isCredentialUnavailable, loadTestEnv } from '../support/test-env';

// End-to-end validation against a real Foundry hosted agent. Gated off by default; it needs a deployed agent
// (see foundry/README.md), RUN_FOUNDRY_WORKERPOOL_E2E=1, FOUNDRY_PROJECT_ENDPOINT + FOUNDRY_AGENT_NAME (from
// tests/.env or process env), and `az login`. It exercises the real data plane and the durable-session lifecycle:
// scaleOut keys the Foundry session on the pinned session's workspaceRef (held liveness invocation); a `retain`
// scaleIn (pause) releases compute but keeps the session alive so a resume reaches the same sandbox; a `release`
// scaleIn (session end) deletes it.
test('scenario: foundry host pool adapter creates and deletes a real Foundry session', async (context) => {
  if (process.env.RUN_FOUNDRY_WORKERPOOL_E2E !== '1') {
    context.skip('set RUN_FOUNDRY_WORKERPOOL_E2E=1 to run Foundry WorkerPool end-to-end validation');
    return;
  }
  const env = loadTestEnv();
  const projectEndpoint = process.env.FOUNDRY_PROJECT_ENDPOINT ?? env.FOUNDRY_PROJECT_ENDPOINT;
  const agentName = process.env.FOUNDRY_AGENT_NAME ?? env.FOUNDRY_AGENT_NAME;
  if (!projectEndpoint || !agentName) {
    context.skip('set FOUNDRY_PROJECT_ENDPOINT and FOUNDRY_AGENT_NAME (in tests/.env) to run the Foundry WorkerPool e2e');
    return;
  }

  const credential = new DefaultAzureCredential();
  const adapter = new FoundryHostPoolAdapter({
    projectEndpoint,
    agentName,
    workerType: 'copilot-local',
    credential
  });
  // A deleted session lingers in the list with status "deleted"; only "active" ones are reusable sandboxes.
  // Timestamps are unix-epoch seconds (numbers), not ISO strings.
  const listSessions = async (): Promise<Array<{ agent_session_id: string; status: string; created_at?: number; last_accessed_at?: number }>> => {
    const token = await credential.getToken('https://ai.azure.com/.default');
    const response = await fetch(`${projectEndpoint.replace(/\/+$/, '')}/agents/${agentName}/endpoint/sessions?api-version=v1`, {
      headers: { authorization: `Bearer ${token?.token ?? ''}`, 'foundry-features': 'HostedAgents=V1Preview' }
    });
    const body = (await response.json()) as { data?: Array<{ agent_session_id: string; status: string; created_at?: number; last_accessed_at?: number }> };
    return body.data ?? [];
  };
  const findSession = (sessions: Array<{ agent_session_id: string; status: string; created_at?: number; last_accessed_at?: number }>, id: string) =>
    sessions.find((session) => session.agent_session_id === id);
  // Status transitions are eventual and pass through a transient `updating`; poll until the target status settles.
  // Observed lifecycle: active (compute up) -> updating -> idle (compute off, $HOME kept, reusable); delete -> deleted.
  const pollStatus = async (id: string, wanted: string, attempts: number) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await delay(2_000);
      const record = findSession(await listSessions(), id);
      if (record?.status === wanted) {
        return record;
      }
    }
    return undefined;
  };
  const now = new Date().toISOString();
  const pool: WorkerPoolRecord = {
    poolId: 'foundry-copilot',
    tenantId: 'e2e',
    template: { labels: { agent: 'copilot', storage: 'host-managed' }, capacity: 1 },
    hostPoolControllerClass: 'foundry',
    scalePolicy: { scaleOutMaxPendingPerTick: 1, scaleInIdleMs: 5_000 },
    centralUrlForWorkers: 'http://central.invalid:3000',
    reuse: false
  };
  const workspaceRef = `ws-e2e-${Date.now()}`;
  const instance: HostPoolInstanceRecord = {
    instanceId: `e2e-${Date.now()}`,
    tenantId: 'e2e',
    poolId: 'foundry-copilot',
    hostPoolControllerClass: 'foundry',
    labels: { agent: 'copilot', storage: 'host-managed' },
    capacity: 1,
    state: 'pending',
    // no-reuse pools pin the instance to a session; the durable Foundry session is keyed on its workspaceRef
    boundSessionId: `sess-e2e-${Date.now()}`,
    workspaceRef,
    createdAt: now,
    updatedAt: now
  };

  try {
    // BOOT: scaleOut invokes the durable session id (the pinned workspaceRef) and holds the liveness request.
    const result = await adapter.scaleOut({ pool, instance });
    assert.equal(result.containerId, workspaceRef, 'scaleOut keys the Foundry session on the pinned session workspaceRef');
    const booted = await pollStatus(result.containerId, 'active', 20);
    assert.ok(booted, `scaleOut session ${result.containerId} should become active on the platform`);

    // PAUSE: `retain` stops the compute (aborts the held request + POST /stop). On the platform the session
    // settles to `idle` (compute off, session record + $HOME kept) - the reusable "stopped" state, distinct from
    // `active` (compute running) and `deleted` (gone). It must NOT be deleted.
    await adapter.scaleIn({ pool, instance: { ...instance, containerId: result.containerId }, durableAction: 'retain' });
    const afterPause = await pollStatus(result.containerId, 'idle', 20);
    assert.ok(afterPause, `retain (stop) must leave session ${result.containerId} idle (stopped but reusable)`);

    // RESUME: a fresh instance carrying the SAME workspaceRef re-invokes the stopped session. This is the real
    // resume cold-boot path - stop-then-invoke must reach the same durable session and re-activate it, otherwise
    // the pause/resume loop hangs.
    const resumeInstance: HostPoolInstanceRecord = { ...instance, instanceId: `e2e-resume-${Date.now()}` };
    const resumed = await adapter.scaleOut({ pool, instance: resumeInstance });
    assert.equal(resumed.containerId, workspaceRef, 'resume reuses the same durable Foundry session id');
    const afterResume = await pollStatus(resumed.containerId, 'active', 20);
    assert.ok(afterResume, `a paused (stopped) session ${resumed.containerId} must be re-invokable so resume cold-boots`);
    // A fresh generation confirms the re-invoke actually reached the platform (not a stale read): the stopped
    // `idle` session was re-invoked into a new container, so last_accessed_at advances past the idle value.
    if (typeof afterResume.last_accessed_at === 'number' && typeof afterPause?.last_accessed_at === 'number') {
      assert.ok(
        afterResume.last_accessed_at > afterPause.last_accessed_at,
        `the resume invocation should refresh last_accessed_at (${afterResume.last_accessed_at} > ${afterPause.last_accessed_at})`
      );
    }

    // SESSION END: `release` deletes the durable session.
    await adapter.scaleIn({ pool, instance: { ...resumeInstance, containerId: resumed.containerId }, durableAction: 'release' });
    const deleted = await pollStatus(resumed.containerId, 'deleted', 15);
    assert.ok(deleted, `release should delete session ${resumed.containerId}`);
  } catch (error) {
    if (isCredentialUnavailable(error)) {
      context.skip('Azure credential unavailable; run az login to exercise the Foundry WorkerPool e2e');
      return;
    }
    throw error;
  }
});
