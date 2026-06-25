import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { AgentSpecAdmissionManager } from '../../src/central/managers';
import { POC_AGENT_SPEC } from '../../src/central/registries/poc-class-registry';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { DockerWorkspaceAdapter } from '../../src/sidecar/adapters';
import { SidecarDaemon } from '../../src/sidecar/sidecar-daemon';
import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, type RuntimeChannel, type RuntimeEvent, type RuntimeEventHandler, type RuntimeEventTransport, type RuntimeSubscription, type WorkerRegisterPayload } from '../../src/shared';
import type { SidecarAgentProcessAdapter, SidecarAgentProcessEventHandler, SidecarAgentProcessInput, SidecarAgentProcessStartInput, SidecarRuntimeTransport, SidecarWorkspaceAdapter, SidecarWorkspaceMount } from '../../src/sidecar/contracts';

class SidecarInMemoryTransport implements SidecarRuntimeTransport {
  constructor(private readonly transport: RuntimeEventTransport, readonly publishedEvents: RuntimeEvent[] = []) {}

  async connect(): Promise<void> {
    return;
  }

  async publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void> {
    this.publishedEvents.push(event);
    await this.transport.publish(channel, event, {
      principal: {
        principalId: 'test-sidecar',
        type: 'service'
      }
    });
  }

  async subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription> {
    return this.transport.subscribe(channel, handler);
  }

  async stop(): Promise<void> {
    return;
  }
}

class PassthroughWorkspaceAdapter implements SidecarWorkspaceAdapter {
  mount(input: SidecarWorkspaceMount): SidecarWorkspaceMount {
    return input;
  }
}

class DeterministicAgentProcessAdapter implements SidecarAgentProcessAdapter {
  readonly starts: SidecarAgentProcessStartInput[] = [];
  readonly sends: SidecarAgentProcessInput[] = [];

  async start(input: SidecarAgentProcessStartInput): Promise<void> {
    this.starts.push(input);
  }

  async send(input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<void> {
    this.sends.push(input);
    await emit({
      type: 'output',
      payload: {
        message: `reply:${input.message}`,
        output: {
          echoed: input.message
        }
      }
    });
  }
}

class FailingStartAgentProcessAdapter extends DeterministicAgentProcessAdapter {
  async start(input: SidecarAgentProcessStartInput): Promise<void> {
    this.starts.push(input);
    throw new Error('copilot runtime failed to start');
  }
}

class DeferredStartAgentProcessAdapter extends DeterministicAgentProcessAdapter {
  private resolveStart!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStart = resolve;
  });

  async start(input: SidecarAgentProcessStartInput): Promise<void> {
    this.starts.push(input);
    await this.started;
  }

  completeStart(): void {
    this.resolveStart();
  }
}

test('scenario: same session supports multi-turn Copilot exchange', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-slice5-loop-'));
  try {
    const runtimeTransport = new InMemoryRuntimeTransportAdapter();
    const storage = new LocalFileStorage(root);
    const central = new CentralService({ storage, eventTransport: runtimeTransport, connectionIssuer: runtimeTransport });
    await central.start();

    const grant = await central.negotiateSidecarConnectionForTenant('poc', sidecarContext(), workerRegistration());
    const worker = grant.worker;
    assert.ok(worker);
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, workerHeartbeatEvent(worker.workerId), sidecarContext());

    const sidecarTransport = new SidecarInMemoryTransport(runtimeTransport);
    const agentProcessAdapter = new DeterministicAgentProcessAdapter();
    const sidecar = new SidecarDaemon({
      runtimeTransport: sidecarTransport,
      workspaceAdapter: new PassthroughWorkspaceAdapter(),
      agentProcessAdapter
    });
    await sidecar.subscribeWorkerCommands(worker.workerId);

    await runtimeTransport.publish({ kind: 'tenant-inbox' }, createSessionEvent(), userContext('demo-user'));
    const [session] = await storage.readSessions();
    assert.ok(session);
    assert.equal(session.status, 'running');
    assert.equal(session.currentWorkerId, worker.workerId);
    assert.equal(agentProcessAdapter.starts.length, 1);
    assert.equal(agentProcessAdapter.starts[0].sessionId, session.sessionId);
    assert.equal(agentProcessAdapter.starts[0].workerId, worker.workerId);
    assert.equal(agentProcessAdapter.starts[0].sessionLeaseId, session.sessionLeaseId);
    assert.equal(agentProcessAdapter.starts[0].workspacePath, session.workspaceRef);
    assert.equal(agentProcessAdapter.starts[0].resolvedAgentSpec.agentSpecId, 'copilot-poc');

    await runtimeTransport.publish({ kind: 'tenant-inbox' }, inputReceivedEvent(session.sessionId, 'ack-input-1', 'first'), userContext('demo-user'));
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, inputReceivedEvent(session.sessionId, 'ack-input-2', 'second'), userContext('demo-user'));

    assert.deepEqual(agentProcessAdapter.sends.map((send) => send.message), ['first', 'second']);
    assert.deepEqual(agentProcessAdapter.sends.map((send) => send.turnSeq), [2, 3]);

    const events = await storage.readEvents(session.sessionId, 0);
    assert.deepEqual(events.map((event) => event.type), [
      'session.created',
      'status.changed',
      'input.accepted',
      'agent.output',
      'turn.completed',
      'input.accepted',
      'agent.output',
      'turn.completed'
    ]);
    assert.equal((events[1].payload as { status?: string }).status, 'running');
    assert.equal(events[3].turnSeq, 2);
    assert.equal((events[3].payload as { message?: string }).message, 'reply:first');
    assert.equal(events[4].turnSeq, 2);
    assert.deepEqual(events[4].payload, { result: { message: 'reply:first', output: { echoed: 'first' } } });
    assert.equal(events[6].turnSeq, 3);
    assert.equal((events[6].payload as { message?: string }).message, 'reply:second');
    assert.equal(events[7].turnSeq, 3);
    assert.deepEqual(events[7].payload, { result: { message: 'reply:second', output: { echoed: 'second' } } });

    await sidecar.handleWorkerCommand(sessionInputCommandEvent({ sessionId: session.sessionId, workerId: worker.workerId, sessionLeaseId: 'stale-lease', turnSeq: 4, message: 'stale' }));
    const eventsAfterRejection = await storage.readEvents(session.sessionId, 0);
    const rejection = eventsAfterRejection.at(-1);
    assert.equal(rejection?.type, 'worker.command.rejected');
    assert.deepEqual(rejection?.payload, {
      reason: 'stale_session_lease',
      expectedSessionLeaseId: session.sessionLeaseId,
      receivedSessionLeaseId: 'stale-lease'
    });

    const updatedSession = await storage.readSession(session.sessionId);
    assert.equal(updatedSession?.eventCursor, 9);
    assert.equal(updatedSession?.nextTurnSeq, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: stale worker command cannot reach Copilot runtime', async () => {
  const runtimeTransport = new InMemoryRuntimeTransportAdapter();
  const sidecarTransport = new SidecarInMemoryTransport(runtimeTransport);
  const agentProcessAdapter = new DeterministicAgentProcessAdapter();
  const sidecar = new SidecarDaemon({
    runtimeTransport: sidecarTransport,
    workspaceAdapter: new PassthroughWorkspaceAdapter(),
    agentProcessAdapter
  });

  await sidecar.handleWorkerCommand(sessionAssignEvent({ sessionLeaseId: 'lease-2' }));
  await sidecar.handleWorkerCommand(sessionInputCommandEvent({ sessionLeaseId: 'lease-1', turnSeq: 4, message: 'stale input' }));

  assert.equal(agentProcessAdapter.sends.length, 0);
  const rejection = sidecarTransport.publishedEvents.find((event) => event.type === 'worker.command.rejected');
  assert.ok(rejection);
  assert.equal(rejection.sessionId, 'session-1');
  assert.equal(rejection.sessionLeaseId, 'lease-1');
  assert.deepEqual(rejection.payload, {
    reason: 'stale_session_lease',
    expectedSessionLeaseId: 'lease-2',
    receivedSessionLeaseId: 'lease-1'
  });
});

test('scenario: input arriving during Copilot startup waits for the assigned session', async () => {
  const runtimeTransport = new InMemoryRuntimeTransportAdapter();
  const sidecarTransport = new SidecarInMemoryTransport(runtimeTransport);
  const agentProcessAdapter = new DeferredStartAgentProcessAdapter();
  const sidecar = new SidecarDaemon({
    runtimeTransport: sidecarTransport,
    workspaceAdapter: new PassthroughWorkspaceAdapter(),
    agentProcessAdapter
  });

  const assign = sidecar.handleWorkerCommand(sessionAssignEvent({ sessionLeaseId: 'lease-2' }));
  const input = sidecar.handleWorkerCommand(sessionInputCommandEvent({ sessionLeaseId: 'lease-2', turnSeq: 4, message: 'early input' }));
  await Promise.resolve();

  assert.equal(agentProcessAdapter.starts.length, 1);
  assert.equal(agentProcessAdapter.sends.length, 0);
  assert.equal(sidecarTransport.publishedEvents.some((event) => event.type === 'worker.command.rejected'), false);

  agentProcessAdapter.completeStart();
  await Promise.all([assign, input]);

  assert.deepEqual(agentProcessAdapter.sends.map((send) => send.message), ['early input']);
  const output = sidecarTransport.publishedEvents.find((event) => event.type === 'agent.output');
  assert.equal((output?.payload as { message?: string }).message, 'reply:early input');
});

test('scenario: Copilot runtime start failure reports failed status without crashing sidecar command handling', async () => {
  const runtimeTransport = new InMemoryRuntimeTransportAdapter();
  const sidecarTransport = new SidecarInMemoryTransport(runtimeTransport);
  const agentProcessAdapter = new FailingStartAgentProcessAdapter();
  const sidecar = new SidecarDaemon({
    runtimeTransport: sidecarTransport,
    workspaceAdapter: new PassthroughWorkspaceAdapter(),
    agentProcessAdapter
  });

  await sidecar.handleWorkerCommand(sessionAssignEvent({ sessionLeaseId: 'lease-2' }));
  await sidecar.handleWorkerCommand(sessionInputCommandEvent({ sessionLeaseId: 'lease-2', turnSeq: 4, message: 'should not reach agent' }));

  assert.equal(agentProcessAdapter.starts.length, 1);
  assert.equal(agentProcessAdapter.sends.length, 0);
  const output = sidecarTransport.publishedEvents.find((event) => event.type === 'agent.output');
  assert.deepEqual(output?.payload, {
    error: { message: 'copilot runtime failed to start' }
  });
  const failed = sidecarTransport.publishedEvents.find((event) => event.type === 'status.changed');
  assert.deepEqual(failed?.payload, {
    status: 'failed',
    reason: 'copilot runtime failed to start'
  });
  const rejection = sidecarTransport.publishedEvents.find((event) => event.type === 'worker.command.rejected');
  assert.deepEqual(rejection?.payload, {
    reason: 'unknown_session',
    expectedSessionLeaseId: undefined,
    receivedSessionLeaseId: 'lease-2'
  });
});

test('scenario: Docker workspace adapter maps runtime refs to existing local directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-sidecar-work-root-'));
  const originalSidecarWorkRoot = process.env.SIDECAR_WORK_ROOT;
  process.env.SIDECAR_WORK_ROOT = root;
  try {
    const mounted = new DockerWorkspaceAdapter().mount({
      workspacePath: 'workspace-volume:session-1',
      copilotSessionStatePath: 'copilot-session:session-1'
    });

    assert.ok(existsSync(mounted.workspacePath));
    assert.ok(existsSync(mounted.copilotSessionStatePath));
    assert.match(mounted.workspacePath, /workspaces/);
    assert.match(mounted.copilotSessionStatePath, /copilot-sessions/);
    assert.doesNotMatch(mounted.workspacePath, /workspace-volume:session-1$/);
  } finally {
    restoreEnv('SIDECAR_WORK_ROOT', originalSidecarWorkRoot);
    await rm(root, { recursive: true, force: true });
  }
});

function workerRegistration(): WorkerRegisterPayload {
  return {
    sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
    labels: { agent: 'copilot' },
    capacity: 1,
    allocatable: 1
  };
}

function workerHeartbeatEvent(workerId: string): RuntimeEvent {
  return {
    eventId: 'evt-worker-heartbeat',
    workerId,
    sequence: 0,
    type: 'worker.heartbeat',
    timestamp: new Date().toISOString(),
    actor: 'sidecar',
    payload: {
      workerId,
      capacity: 1,
      allocatable: 1,
      conditions: ['ready']
    }
  };
}

function createSessionEvent(): RuntimeEvent {
  return {
    eventId: 'evt-create-session',
    ackId: 'ack-create',
    sequence: 0,
    type: 'session.create.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: {
      agent: { agentSpecId: 'copilot-poc' },
      input: { message: 'start session' },
      workspace: { source: 'empty' }
    }
  };
}

function inputReceivedEvent(sessionId: string, ackId: string, message: string): RuntimeEvent {
  return {
    eventId: `evt-${ackId}`,
    sessionId,
    ackId,
    sequence: 0,
    type: 'input.received',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: {
      input: { message }
    }
  };
}

function sessionAssignEvent(input: { sessionLeaseId: string }): RuntimeEvent {
  const resolvedAgentSpec = new AgentSpecAdmissionManager({ now: () => '2026-06-24T00:00:00.000Z' }).resolve(POC_AGENT_SPEC);
  return {
    eventId: 'evt-assign',
    sessionId: 'session-1',
    workerId: 'worker-1',
    sequence: 1,
    type: 'session.assign',
    timestamp: new Date().toISOString(),
    actor: 'central',
    sessionLeaseId: input.sessionLeaseId,
    payload: {
      sessionId: 'session-1',
      workerId: 'worker-1',
      sessionLeaseId: input.sessionLeaseId,
      workspaceRef: 'workspace-volume:session-1',
      copilotSessionStateRef: 'copilot-session:session-1',
      resolvedAgentSpec
    }
  };
}

function sessionInputCommandEvent(input: { sessionLeaseId: string; turnSeq: number; message: string; sessionId?: string; workerId?: string }): RuntimeEvent {
  const sessionId = input.sessionId ?? 'session-1';
  const workerId = input.workerId ?? 'worker-1';
  return {
    eventId: 'evt-session-input',
    sessionId,
    workerId,
    turnSeq: input.turnSeq,
    sequence: 2,
    type: 'session.input',
    timestamp: new Date().toISOString(),
    actor: 'central',
    sessionLeaseId: input.sessionLeaseId,
    payload: {
      sessionId,
      workerId,
      sessionLeaseId: input.sessionLeaseId,
      turnSeq: input.turnSeq,
      input: { message: input.message }
    }
  };
}

function userContext(principalId: string) {
  return {
    principal: {
      principalId,
      type: 'user' as const
    },
    connectionId: `${principalId}-connection`
  };
}

function sidecarContext() {
  return {
    principal: {
      principalId: 'slice5-sidecar',
      type: 'service' as const
    }
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
