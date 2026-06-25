import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentSpecAdmissionManager, WorkerSelector } from '../../src/central/managers';
import { POC_AGENT_SPEC } from '../../src/central/registries/poc-class-registry';
import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, SystemClock, type SessionRecord, type WorkerRecord } from '../../src/shared';

test('scenario: queued session is assigned to matching ready worker', () => {
  const now = new Date().toISOString();
  const resolvedAgentSpec = new AgentSpecAdmissionManager(new SystemClock()).resolve(POC_AGENT_SPEC);
  const session: SessionRecord = {
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    owner: 'owner-1',
    resolvedAgentSpec,
    status: 'queued',
    sessionLeaseId: undefined,
    eventCursor: 0,
    nextTurnSeq: 1,
    workspaceRef: 'workspace-volume',
    lastEventUpdatedAt: now,
    createdAt: now,
    updatedAt: now
  };
  const worker: WorkerRecord = {
    workerId: 'worker-1',
    tenantId: 'tenant-1',
    capacityScope: 'tenant-1',
    sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
    labels: { agent: 'copilot' },
    capacity: 1,
    allocatable: 1,
    conditions: ['ready'],
    lifecycleState: 'active',
    heartbeatAt: now,
    expiresAt: new Date(Date.parse(now) + 30_000).toISOString(),
    currentSessionCount: 0,
    updatedAt: now
  };

  const selected = new WorkerSelector().select(session, [worker]);

  assert.equal(selected?.workerId, 'worker-1');
});