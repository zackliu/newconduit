import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import type { HostPoolAdapter, HostPoolScaleInInput, HostPoolScaleOutInput, HostPoolScaleOutResult } from '../../src/central/managers';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { DockerWorkspaceAdapter } from '../../src/sidecar/adapters';
import { SidecarDaemon } from '../../src/sidecar/sidecar-daemon';
import type { SidecarAgentProcessAdapter, SidecarAgentProcessEventHandler, SidecarAgentProcessInput, SidecarAgentProcessStartInput, SidecarAgentTurnResult, SidecarRuntimeTransport } from '../../src/sidecar/contracts';
import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, type RequestContext, type RuntimeChannel, type RuntimeEvent, type RuntimeEventHandler, type RuntimeEventTransport, type RuntimeSubscription, type SessionRecord, type WorkerPoolRecord, type WorkerRecord, type WorkerRegisterPayload } from '../../src/shared';

const CONTINUITY_FILE = 'continuity.txt';
const CONTINUITY_CONTENT = 'RESUME-OK-7f3a';

test('scenario: a recycled session restores its workspace and memory before the next turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ars-session-memory-'));
  const tenantId = 'poc';
  const runtimeTransport = new InMemoryRuntimeTransportAdapter();
  const storage = new LocalFileStorage(root);
  const workerPool: WorkerPoolRecord = {
    poolId: 'memory-pool',
    tenantId,
    sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
    labels: { agent: 'copilot' },
    capacityPerWorker: 1,
    hostPoolControllerClass: 'inproc',
    scalePolicy: { scaleOutMaxPendingPerTick: 1, scaleInIdleMs: 0 },
    centralUrlForWorkers: 'inproc://central'
  };
  const adapter = new InProcessHostPoolAdapter({
    transport: runtimeTransport,
    storage,
    tenantId,
    workersRoot: join(root, 'workers'),
    snapshotRoot: join(root, 'snapshots'),
    negotiate: (registration) => central.negotiateSidecarConnectionForTenant(tenantId, serviceContext(registration.principalId), registration.payload)
  });
  const central: CentralService = new CentralService({
    storage,
    eventTransport: runtimeTransport,
    connectionIssuer: runtimeTransport,
    tenant: { tenantId, storageRoot: root, webPubSubHub: 'agent-runtime-poc' },
    workerPools: [workerPool],
    hostPoolAdapters: { inproc: adapter }
  });

  async function pump(): Promise<void> {
    await adapter.heartbeatLiveWorkers();
    await central.reconcileSessionsForTenant(tenantId);
    await wait(10);
  }

  async function waitUntil<T>(check: () => Promise<T | undefined>, label: string, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await pump();
      const result = await check();
      if (result !== undefined) {
        return result;
      }
    }
    throw new Error(`timed out waiting for ${label}; session=${JSON.stringify(await storage.readSession(sessionId))}`);
  }

  let sessionId = '';
  try {
    await central.start();

    // Create the durable session. No worker exists yet, so it queues until the pool scales out worker A.
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, createSessionEvent(), userContext());
    const created = await waitUntilSession(storage, (candidate) => candidate.status === 'queued' || candidate.status === 'running');
    sessionId = created.sessionId;

    const runningOnA = await waitUntil(async () => {
      const session = await storage.readSession(sessionId);
      return session?.status === 'running' && session.currentWorkerId ? session : undefined;
    }, 'session running on worker A');
    const workerAId = runningOnA.currentWorkerId!;

    // Turn 1: the agent writes a workspace file and records it in its own session memory.
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, inputEvent(sessionId, 'turn-write', `create-file:${CONTINUITY_FILE}:${CONTINUITY_CONTENT}`), userContext());
    const firstTurn = await waitUntil(async () => {
      const result = await latestTurnResult(storage, sessionId);
      return result && result.artifact === CONTINUITY_FILE ? result : undefined;
    }, 'turn 1 completed on worker A');
    assert.equal(firstTurn.turns, 1);
    assert.equal(firstTurn.content, CONTINUITY_CONTENT);

    // Pause: the sidecar captures workspace + agent session state into the session-addressed snapshot store.
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, pauseEvent(sessionId, 'pause-1'), userContext());
    const paused = await waitUntil(async () => {
      const session = await storage.readSession(sessionId);
      return session?.status === 'paused' && session.latestSnapshotRef ? session : undefined;
    }, 'session paused with snapshot');

    // The captured workspace part durably holds the file, addressed by session identity (not worker identity).
    const capturedFile = join(root, 'snapshots', sessionId, paused.latestSnapshotRef!, 'parts', 'workspace', CONTINUITY_FILE);
    assert.equal(await readFile(capturedFile, 'utf8'), CONTINUITY_CONTENT);

    // Recycle: the pool scales worker A in. Its local volume is gone; only the session-addressed snapshot remains.
    await waitUntil(async () => {
      const worker = await storage.readWorker(workerAId);
      return worker && worker.lifecycleState !== 'active' ? worker : undefined;
    }, 'worker A recycled');
    assert.equal(adapter.liveInstanceCount(), 0);

    // Resume: a fresh worker B restores both parts before the agent starts the next turn.
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, resumeEvent(sessionId, 'resume-1'), userContext());
    const runningOnB = await waitUntil(async () => {
      const session = await storage.readSession(sessionId);
      return session?.status === 'running' && session.currentWorkerId && session.currentWorkerId !== workerAId ? session : undefined;
    }, 'session running on a new worker B');
    const workerBId = runningOnB.currentWorkerId!;
    assert.notEqual(workerBId, workerAId);

    // Worker B's restored workspace already holds the file written before the recycle.
    const restoredFile = join(root, 'workers', currentInstanceId(adapter, workerBId), 'workspaces', encodeWorkspaceSegment(runningOnB.workspaceRef), CONTINUITY_FILE);
    assert.equal(await readFile(restoredFile, 'utf8'), CONTINUITY_CONTENT);

    // Turn 2: the agent recalls the file it created earlier without being told its name, then reads it back.
    await runtimeTransport.publish({ kind: 'tenant-inbox' }, inputEvent(sessionId, 'turn-recall', 'recall'), userContext());
    const secondTurn = await waitUntil(async () => {
      const result = await latestTurnResult(storage, sessionId);
      return result && result.turns === 2 ? result : undefined;
    }, 'turn 2 completed on worker B');

    assert.equal(secondTurn.artifact, CONTINUITY_FILE, 'restored agent memory remembers the created file');
    assert.equal(secondTurn.content, CONTINUITY_CONTENT, 'restored workspace is readable by the new worker');

    const finalSession = await storage.readSession(sessionId);
    assert.equal(finalSession?.status, 'running');
  } finally {
    await adapter.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});

interface AgentMemory {
  turns: string[];
  artifact?: { name: string; content: string };
}

interface AgentRun {
  workspacePath: string;
  copilotStatePath: string;
  memory: AgentMemory;
}

/**
 * Simulates a Copilot-style agent that keeps its conversation memory in its own session files under the
 * agent-state directory and reattaches to that memory on start, so recovery depends on restoring those files.
 */
class MemoryCodingAgent implements SidecarAgentProcessAdapter {
  private readonly runs = new Map<string, AgentRun>();

  async start(input: SidecarAgentProcessStartInput): Promise<void> {
    this.runs.set(input.sessionId, {
      workspacePath: input.workspacePath,
      copilotStatePath: input.copilotSessionStatePath,
      memory: this.loadMemory(input.copilotSessionStatePath)
    });
  }

  async send(input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<SidecarAgentTurnResult> {
    const run = this.runs.get(input.sessionId);
    if (!run) {
      throw new Error(`agent session ${input.sessionId} is not running`);
    }
    run.memory.turns.push(input.message);
    this.applyCommand(run, input.message);
    this.saveMemory(run);
    const artifactContent = run.memory.artifact ? readFileSync(join(run.workspacePath, run.memory.artifact.name), 'utf8') : undefined;
    const message = JSON.stringify({ turns: run.memory.turns.length, artifact: run.memory.artifact?.name, content: artifactContent });
    await emit({ type: 'output', payload: { message } });
    return { message };
  }

  async stop(input: { sessionId: string }): Promise<void> {
    this.runs.delete(input.sessionId);
  }

  private applyCommand(run: AgentRun, message: string): void {
    const match = /^create-file:([^:]+):(.*)$/s.exec(message);
    if (!match) {
      return;
    }
    const [, name, content] = match;
    mkdirSync(run.workspacePath, { recursive: true });
    writeFileSync(join(run.workspacePath, name), content, 'utf8');
    run.memory.artifact = { name, content };
  }

  private loadMemory(copilotStatePath: string): AgentMemory {
    const path = join(copilotStatePath, 'memory.json');
    if (!existsSync(path)) {
      return { turns: [] };
    }
    return JSON.parse(readFileSync(path, 'utf8')) as AgentMemory;
  }

  private saveMemory(run: AgentRun): void {
    mkdirSync(run.copilotStatePath, { recursive: true });
    writeFileSync(join(run.copilotStatePath, 'memory.json'), JSON.stringify(run.memory), 'utf8');
  }
}

interface NegotiateInput {
  principalId: string;
  payload: WorkerRegisterPayload;
}

interface InProcessHostPoolAdapterOptions {
  transport: InMemoryRuntimeTransportAdapter;
  storage: LocalFileStorage;
  tenantId: string;
  workersRoot: string;
  snapshotRoot: string;
  negotiate: (input: NegotiateInput) => Promise<{ worker?: WorkerRecord }>;
}

/**
 * Mirrors the Docker WorkerPool host pool adapter in-process: scale-out starts a real SidecarDaemon with a
 * fresh per-instance work root and a shared session-addressed snapshot root, and scale-in stops it.
 */
class InProcessHostPoolAdapter implements HostPoolAdapter {
  private readonly daemons = new Map<string, { daemon: SidecarDaemon; workerId: string }>();

  constructor(private readonly options: InProcessHostPoolAdapterOptions) {}

  async scaleOut(input: HostPoolScaleOutInput): Promise<HostPoolScaleOutResult> {
    const instanceId = input.instance.instanceId;
    const grant = await this.options.negotiate({
      principalId: `sidecar-${instanceId}`,
      payload: {
        sidecarClass: input.pool.sidecarClass,
        labels: input.pool.labels,
        capacity: input.pool.capacityPerWorker,
        allocatable: input.pool.capacityPerWorker,
        description: { workerPoolInstanceId: instanceId }
      }
    });
    const worker = grant.worker;
    if (!worker) {
      throw new Error('in-process negotiate did not return a worker');
    }
    const daemon = new SidecarDaemon({
      runtimeTransport: new SidecarInMemoryTransport(this.options.transport, `sidecar-${instanceId}`),
      workspaceAdapter: new DockerWorkspaceAdapter({ workRoot: join(this.options.workersRoot, instanceId), snapshotRoot: this.options.snapshotRoot }),
      agentProcessAdapter: new MemoryCodingAgent()
    });
    await daemon.subscribeWorkerCommands(worker.workerId);
    this.daemons.set(instanceId, { daemon, workerId: worker.workerId });
    await this.publishHeartbeat(worker.workerId, instanceId);
    return { containerId: instanceId };
  }

  async scaleIn(input: HostPoolScaleInInput): Promise<void> {
    const entry = this.daemons.get(input.instance.instanceId);
    if (!entry) {
      return;
    }
    this.daemons.delete(input.instance.instanceId);
    await entry.daemon.stop();
  }

  async heartbeatLiveWorkers(): Promise<void> {
    for (const [instanceId, entry] of this.daemons) {
      await this.publishHeartbeat(entry.workerId, instanceId);
    }
  }

  liveInstanceCount(): number {
    return this.daemons.size;
  }

  instanceIdForWorker(workerId: string): string | undefined {
    for (const [instanceId, entry] of this.daemons) {
      if (entry.workerId === workerId) {
        return instanceId;
      }
    }
    return undefined;
  }

  async stopAll(): Promise<void> {
    const daemons = [...this.daemons.values()];
    this.daemons.clear();
    await Promise.all(daemons.map((entry) => entry.daemon.stop()));
  }

  private async publishHeartbeat(workerId: string, instanceId: string): Promise<void> {
    const worker = await this.options.storage.readWorker(workerId);
    if (!worker || (worker.lifecycleState !== 'active' && worker.lifecycleState !== 'registered')) {
      return;
    }
    const allocatable = Math.max(0, worker.capacity - worker.currentSessionCount);
    await this.options.transport.publish({ kind: 'tenant-inbox' }, {
      eventId: crypto.randomUUID(),
      workerId,
      sequence: 0,
      type: 'worker.heartbeat',
      timestamp: new Date().toISOString(),
      actor: 'sidecar',
      payload: { workerId, capacity: worker.capacity, allocatable, conditions: allocatable > 0 ? ['ready'] : ['busy'] }
    }, serviceContext(`sidecar-${instanceId}`));
  }
}

class SidecarInMemoryTransport implements SidecarRuntimeTransport {
  constructor(private readonly transport: RuntimeEventTransport, private readonly principalId: string) {}

  async connect(): Promise<void> {
    return;
  }

  async publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void> {
    await this.transport.publish(channel, event, serviceContext(this.principalId));
  }

  async subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription> {
    return this.transport.subscribe(channel, handler);
  }

  async stop(): Promise<void> {
    return;
  }
}

function currentInstanceId(adapter: InProcessHostPoolAdapter, workerId: string): string {
  const instanceId = adapter.instanceIdForWorker(workerId);
  if (!instanceId) {
    throw new Error(`no live instance for worker ${workerId}`);
  }
  return instanceId;
}

function encodeWorkspaceSegment(value: string): string {
  return encodeURIComponent(value).replaceAll('%', '_');
}

async function waitUntilSession(storage: LocalFileStorage, predicate: (session: SessionRecord) => boolean, timeoutMs = 5_000): Promise<SessionRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [session] = await storage.readSessions();
    if (session && predicate(session)) {
      return session;
    }
    await wait(10);
  }
  throw new Error('timed out waiting for session to exist');
}

async function latestTurnResult(storage: LocalFileStorage, sessionId: string): Promise<{ turns: number; artifact?: string; content?: string } | undefined> {
  const events = await storage.readEvents(sessionId, 0);
  const completed = events.filter((event) => event.type === 'turn.completed').at(-1);
  const message = (completed?.payload as { result?: { message?: string } } | undefined)?.result?.message;
  return message ? JSON.parse(message) as { turns: number; artifact?: string; content?: string } : undefined;
}

function createSessionEvent(): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    ackId: 'ack-create',
    sequence: 0,
    type: 'session.create.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: {
      agent: { agentSpecId: 'copilot-poc' },
      input: { message: 'start a durable memory session' },
      workspace: { source: 'empty' }
    }
  };
}

function inputEvent(sessionId: string, ackId: string, message: string): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId,
    ackId,
    sequence: 0,
    type: 'input.received',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: { input: { message } }
  };
}

function pauseEvent(sessionId: string, ackId: string): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId,
    ackId,
    sequence: 0,
    type: 'session.pause.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: {}
  };
}

function resumeEvent(sessionId: string, ackId: string): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId,
    ackId,
    sequence: 0,
    type: 'session.resume.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: {}
  };
}

function userContext(): RequestContext {
  return { principal: { principalId: 'demo-user', type: 'user' }, connectionId: 'demo-user-connection' };
}

function serviceContext(principalId: string): RequestContext {
  return { principal: { principalId, type: 'service' } };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
