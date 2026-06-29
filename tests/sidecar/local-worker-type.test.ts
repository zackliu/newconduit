import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { CopilotProcessAdapter, LocalWorkspaceAdapter } from '../../src/sidecar/adapters';
import { SidecarDaemon } from '../../src/sidecar/sidecar-daemon';
import { resolveWorkerType } from '../../src/sidecar/worker-types';
import { COPILOT_LOCAL_PROCESS_SIDECAR_CLASS, type RuntimeChannel, type RuntimeEvent, type RuntimeEventHandler, type RuntimeEventTransport, type RuntimeSubscription, type WorkerRegisterPayload } from '../../src/shared';
import type { SidecarAgentProcessAdapter, SidecarAgentProcessEventHandler, SidecarAgentProcessInput, SidecarAgentProcessStartInput, SidecarAgentTurnResult, SidecarRuntimeTransport, SidecarWorkspaceAdapter, SidecarWorkspaceCaptureInput, SidecarWorkspaceMount, SidecarWorkspaceRestoreInput } from '../../src/sidecar/contracts';

class SidecarInMemoryTransport implements SidecarRuntimeTransport {
  constructor(private readonly transport: RuntimeEventTransport, readonly publishedEvents: RuntimeEvent[] = []) {}
  async connect(): Promise<void> {}
  async publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void> {
    this.publishedEvents.push(event);
    await this.transport.publish(channel, event, { principal: { principalId: 'local-sidecar', type: 'service' } });
  }
  async subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription> {
    return this.transport.subscribe(channel, handler);
  }
  async stop(): Promise<void> {}
}

class LocalCaptureWorkspaceAdapter extends LocalWorkspaceAdapter {
  readonly captures: SidecarWorkspaceCaptureInput[] = [];
  readonly restores: SidecarWorkspaceRestoreInput[] = [];
  async capture(input: SidecarWorkspaceCaptureInput): Promise<[]> {
    this.captures.push(input);
    return [];
  }
  async restore(input: SidecarWorkspaceRestoreInput): Promise<void> {
    this.restores.push(input);
  }
}

class DeterministicAgentProcessAdapter implements SidecarAgentProcessAdapter {
  readonly starts: SidecarAgentProcessStartInput[] = [];
  readonly stops: string[] = [];
  async start(input: SidecarAgentProcessStartInput): Promise<void> {
    this.starts.push(input);
  }
  async send(input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<SidecarAgentTurnResult> {
    const result = { message: `reply:${input.message}` };
    await emit({ type: 'output', payload: { message: result.message } });
    return result;
  }
  async stop(input: { sessionId: string }): Promise<void> {
    this.stops.push(input.sessionId);
  }
}

test('scenario: worker type binds adapters so startup only references the type', () => {
  const workerType = resolveWorkerType('copilot-local');
  assert.equal(workerType.sidecarClass, COPILOT_LOCAL_PROCESS_SIDECAR_CLASS);
  assert.deepEqual(workerType.labels, { agent: 'local' });
  assert.equal(workerType.capacity, 99);
  assert.ok(workerType.createWorkspaceAdapter() instanceof LocalWorkspaceAdapter);
  assert.ok(workerType.createAgentProcessAdapter() instanceof CopilotProcessAdapter);
  assert.throws(() => resolveWorkerType('does-not-exist'));
});

test('scenario: local agent spec assigns to local worker without docker scale-out, then pause/resume reattaches without snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-slice9-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const grant = await central.negotiateSidecarConnectionForTenant('poc', sidecarContext(), localWorkerRegistration());
    const worker = grant.worker;
    assert.ok(worker);
    assert.equal(worker.sidecarClass, COPILOT_LOCAL_PROCESS_SIDECAR_CLASS);
    assert.equal(worker.capacity, 99);
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, workerHeartbeatEvent(worker.workerId), sidecarContext());

    const sidecar = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(runtimeTransport),
      workspaceAdapter: new LocalCaptureWorkspaceAdapter({ workRoot: join(root, 'local') }),
      agentProcessAdapter: new DeterministicAgentProcessAdapter()
    });
    await sidecar.subscribeWorkerCommands(worker.workerId);

    await runtimeTransport.publish({ kind: 'tenant-inbox' }, createLocalSessionEvent('ack-a'), userContext('demo-user'));
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, createLocalSessionEvent('ack-b'), userContext('demo-user'));
    const sessions = await storage.readSessions();
    assert.equal(sessions.length, 2);
    for (const session of sessions) {
      assert.equal(session.status, 'running');
      assert.equal(session.currentWorkerId, worker.workerId);
      assert.equal(session.resolvedAgentSpec.agentSpecId, 'copilot-local');
    }
    const afterAssign = await storage.readWorker(worker.workerId);
    assert.equal(afterAssign?.allocatable, 97);

    const target = sessions[0];
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, pauseEvent(target.sessionId, 'ack-pause'), userContext('demo-user'));
    const paused = await storage.readSession(target.sessionId);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.latestSnapshotRef, undefined);
    assert.equal(existsSync(join(root, 'snapshots')), false);
    const freed = await storage.readWorker(worker.workerId);
    assert.equal(freed?.allocatable, 98);

    await runtimeTransport.publish({ kind: 'tenant-inbox' }, resumeEvent(target.sessionId, 'ack-resume'), userContext('demo-user'));
    const resumed = await storage.readSession(target.sessionId);
    assert.equal(resumed?.status, 'running');
    assert.equal(resumed?.currentWorkerId, worker.workerId);
    assert.equal(resumed?.latestSnapshotRef, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function localWorkerRegistration(): WorkerRegisterPayload {
  const workerType = resolveWorkerType('copilot-local');
  return { sidecarClass: workerType.sidecarClass, labels: workerType.labels, capacity: workerType.capacity, allocatable: workerType.capacity };
}

function workerHeartbeatEvent(workerId: string): RuntimeEvent {
  return {
    eventId: 'evt-heartbeat',
    workerId,
    sequence: 0,
    type: 'worker.heartbeat',
    timestamp: new Date().toISOString(),
    actor: 'sidecar',
    payload: { workerId, capacity: 99, allocatable: 99, conditions: ['ready'] }
  };
}

function createLocalSessionEvent(ackId: string): RuntimeEvent {
  return {
    eventId: `evt-${ackId}`,
    ackId,
    sequence: 0,
    type: 'session.create.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: { agent: { agentSpecId: 'copilot-local' }, workspace: { source: 'empty' } }
  };
}

function pauseEvent(sessionId: string, ackId: string): RuntimeEvent {
  return {
    eventId: `evt-${ackId}`,
    sessionId,
    ackId,
    sequence: 0,
    type: 'session.pause.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: { reason: 'client_requested' }
  };
}

function resumeEvent(sessionId: string, ackId: string): RuntimeEvent {
  return {
    eventId: `evt-${ackId}`,
    sessionId,
    ackId,
    sequence: 0,
    type: 'session.resume.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: { reason: 'client_requested' }
  };
}

function userContext(principalId: string) {
  return { principal: { principalId, type: 'user' as const }, connectionId: `${principalId}-connection` };
}

function sidecarContext() {
  return { principal: { principalId: 'local-sidecar', type: 'service' as const } };
}
