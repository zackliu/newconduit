import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { SidecarDaemon } from '../../src/sidecar/sidecar-daemon';
import type { SidecarAgentProcessAdapter, SidecarAgentProcessEventHandler, SidecarAgentProcessInput, SidecarAgentTurnResult, SidecarInteractionResponseInput, SidecarRuntimeTransport, SidecarWorkspaceAdapter, SidecarWorkspaceCaptureInput, SidecarWorkspaceMount, SidecarWorkspaceRestoreInput } from '../../src/sidecar/contracts';
import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, type RequestContext, type RuntimeChannel, type RuntimeEvent, type RuntimeEventHandler, type RuntimeEventTransport, type RuntimeSubscription, type SessionRecord, type SnapshotPart, type WorkerRegisterPayload } from '../../src/shared';

const TENANT = 'poc';

class SidecarInMemoryTransport implements SidecarRuntimeTransport {
  constructor(private readonly transport: RuntimeEventTransport, readonly publishedEvents: RuntimeEvent[] = []) {}
  async connect(): Promise<void> {}
  async publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void> {
    this.publishedEvents.push(event);
    await this.transport.publish(channel, event, { principal: { principalId: 'interaction-sidecar', type: 'service' } });
  }
  async subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription> {
    return this.transport.subscribe(channel, handler);
  }
  async stop(): Promise<void> {}
}

class PassthroughWorkspaceAdapter implements SidecarWorkspaceAdapter {
  mount(input: SidecarWorkspaceMount): SidecarWorkspaceMount {
    return input;
  }
  async capture(_input: SidecarWorkspaceCaptureInput): Promise<SnapshotPart[]> {
    return [{ name: 'workspace', path: 'parts/workspace' }, { name: 'agent-state', path: 'parts/agent-state' }];
  }
  async restore(_input: SidecarWorkspaceRestoreInput): Promise<void> {}
}

/**
 * Deterministic agent that suspends a turn on off-agent interactions so the runtime broker can be
 * exercised without a real Copilot process. It reacts to specific input messages.
 */
class InteractiveAgentProcessAdapter implements SidecarAgentProcessAdapter {
  private readonly pending = new Map<string, (response: unknown) => void>();
  private sessionApproved = false;

  async start(): Promise<void> {}

  async send(input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<SidecarAgentTurnResult> {
    if (input.message === 'ask-approval') {
      if (this.sessionApproved) {
        return this.finish('auto-approved:deleted', emit);
      }
      const id = `approval-${input.turnSeq}`;
      const answered = this.registerPending(id);
      await emit({ type: 'interaction', payload: { interactionId: id, kind: 'approval', request: { action: 'delete-file' } } });
      const response = await answered;
      if ((response as { scope?: string }).scope === 'session') {
        this.sessionApproved = true;
      }
      return this.finish((response as { decision?: string }).decision === 'approved' ? 'deleted' : 'refused', emit);
    }
    if (input.message === 'ask-two-tools') {
      const idA = `tool-a-${input.turnSeq}`;
      const idB = `tool-b-${input.turnSeq}`;
      const answeredA = this.registerPending(idA);
      const answeredB = this.registerPending(idB);
      await emit({ type: 'interaction', payload: { interactionId: idA, kind: 'tool_call', request: { toolName: 'getA', arguments: {} } } });
      await emit({ type: 'interaction', payload: { interactionId: idB, kind: 'tool_call', request: { toolName: 'getB', arguments: {} } } });
      const [a, b] = await Promise.all([answeredA, answeredB]);
      return this.finish(`${resultText(a)}+${resultText(b)}`, emit);
    }
    if (input.message === 'use-builtin-tool') {
      await emit({ type: 'output', payload: { toolStarted: { toolCallId: 'call-1', toolName: 'bash' } } });
      await emit({ type: 'output', payload: { toolCompleted: { toolCallId: 'call-1', toolName: 'bash' } } });
      return this.finish('ran-tool', emit);
    }
    return this.finish(`reply:${input.message}`, emit);
  }

  async respondToInteraction(input: SidecarInteractionResponseInput): Promise<void> {
    const resolve = this.pending.get(input.interactionId);
    this.pending.delete(input.interactionId);
    resolve?.(input.response);
  }

  private registerPending(interactionId: string): Promise<unknown> {
    return new Promise((resolve) => {
      this.pending.set(interactionId, resolve);
    });
  }

  private async finish(message: string, emit: SidecarAgentProcessEventHandler): Promise<SidecarAgentTurnResult> {
    await emit({ type: 'output', payload: { message, output: { final: message } } });
    return { message, output: { final: message } };
  }
}

function resultText(response: unknown): string {
  const result = (response as { result?: unknown }).result;
  return typeof result === 'string' ? result : JSON.stringify(result);
}

interface Harness {
  central: CentralService;
  transport: InMemoryRuntimeTransportAdapter;
  storage: LocalFileStorage;
  agent: InteractiveAgentProcessAdapter;
  workerId: string;
  root: string;
  session(): Promise<SessionRecord>;
  waitUntil<T>(check: (session: SessionRecord) => T | undefined, label: string): Promise<T>;
  events(): Promise<RuntimeEvent[]>;
  stop(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ars-interaction-'));
  const transport = new InMemoryRuntimeTransportAdapter();
  const storage = new LocalFileStorage(root);
  const central = new CentralService({
    storage,
    eventTransport: transport,
    connectionIssuer: transport,
    tenant: { tenantId: TENANT, storageRoot: root, webPubSubHub: 'agent-runtime-poc' }
  });
  await central.start();
  const grant = await central.negotiateSidecarConnectionForTenant(TENANT, serviceContext(), workerRegistration());
  const worker = grant.worker;
  assert.ok(worker);
  const agent = new InteractiveAgentProcessAdapter();
  const sidecar = new SidecarDaemon({
    runtimeTransport: new SidecarInMemoryTransport(transport),
    workspaceAdapter: new PassthroughWorkspaceAdapter(),
    agentProcessAdapter: agent
  });
  await sidecar.subscribeWorkerCommands(worker.workerId);
  await transport.publish({ kind: 'tenant-inbox' }, workerHeartbeatEvent(worker.workerId), serviceContext());

  const readSession = async (): Promise<SessionRecord> => {
    const [session] = await storage.readSessions();
    assert.ok(session, 'session not created yet');
    return session;
  };

  return {
    central,
    transport,
    storage,
    agent,
    workerId: worker.workerId,
    root,
    session: readSession,
    events: async () => {
      const session = await readSession();
      return storage.readEvents(session.sessionId, 0);
    },
    async waitUntil<T>(check: (session: SessionRecord) => T | undefined, label: string): Promise<T> {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const [session] = await storage.readSessions();
        if (session) {
          const result = check(session);
          if (result !== undefined) {
            return result;
          }
        }
        await wait(10);
      }
      throw new Error(`timed out waiting for ${label}: ${JSON.stringify(await storage.readSessions())}`);
    },
    async stop(): Promise<void> {
      await sidecar.stop();
      await central.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
    }
  };
}

test('scenario: approval interaction survives client absence and resumes the turn', async () => {
  const h = await startHarness();
  try {
    await h.transport.publish({ kind: 'tenant-inbox' }, createSessionEvent('ask-nothing'), userContext());
    const running = await h.waitUntil((session) => (session.status === 'running' ? session : undefined), 'session running');
    // Client is not subscribed to session-events; the agent turn requests an approval.
    await h.transport.publish({ kind: 'tenant-inbox' }, inputEvent(running.sessionId, 'ack-1', 'ask-approval'), userContext());
    const open = await h.waitUntil((session) => (session.openInteractions?.length === 1 ? session.openInteractions[0] : undefined), 'open approval interaction');
    assert.equal(open.kind, 'approval');
    const eventsBefore = await h.events();
    assert.ok(eventsBefore.some((event) => event.type === 'interaction.requested'));
    assert.equal(eventsBefore.filter((event) => event.type === 'turn.completed').length, 0, 'the approval turn has not completed while the interaction is open');

    // The client comes online later and approves once.
    await h.transport.publish({ kind: 'tenant-inbox' }, interactionResponseEvent(running.sessionId, open.interactionId, { decision: 'approved', scope: 'once' }), userContext());
    const events = await waitForEvents(h, (list) => list.some((event) => event.type === 'turn.completed' && event.turnSeq === open.turnSeq), 'approval turn completed');
    assert.ok(events.some((event) => event.type === 'interaction.responded'));
    const session = await h.session();
    assert.equal(session.openInteractions?.length ?? 0, 0);
    const finalOutput = events.filter((event) => event.type === 'agent.output').at(-1);
    assert.equal((finalOutput?.payload as { message?: string }).message, 'deleted');
  } finally {
    await h.stop();
  }
});

test('scenario: parallel client tool interactions resolve independently', async () => {
  const h = await startHarness();
  try {
    await h.transport.publish({ kind: 'tenant-inbox' }, createSessionEvent('ask-nothing'), userContext());
    const running = await h.waitUntil((session) => (session.status === 'running' ? session : undefined), 'session running');
    await h.transport.publish({ kind: 'tenant-inbox' }, inputEvent(running.sessionId, 'ack-1', 'ask-two-tools'), userContext());
    const open = await h.waitUntil((session) => (session.openInteractions?.length === 2 ? session.openInteractions : undefined), 'two open tool interactions');
    assert.deepEqual(open.map((entry) => entry.kind), ['tool_call', 'tool_call']);
    const toolA = open.find((entry) => entry.interactionId.startsWith('tool-a'))!;
    const toolB = open.find((entry) => entry.interactionId.startsWith('tool-b'))!;

    // Respond to the second-requested interaction first; each resolves independently by interactionId.
    await h.transport.publish({ kind: 'tenant-inbox' }, interactionResponseEvent(running.sessionId, toolB.interactionId, { result: 'B' }), userContext());
    await h.waitUntil((session) => (session.openInteractions?.length === 1 ? session : undefined), 'first tool resolved');
    await h.transport.publish({ kind: 'tenant-inbox' }, interactionResponseEvent(running.sessionId, toolA.interactionId, { result: 'A' }), userContext());
    const events = await waitForEvents(h, (list) => list.some((event) => event.type === 'turn.completed' && event.turnSeq === 2), 'tool turn completed');

    assert.equal(events.filter((event) => event.type === 'interaction.responded').length, 2);
    const finalOutput = events.filter((event) => event.type === 'agent.output').at(-1);
    assert.equal((finalOutput?.payload as { message?: string }).message, 'A+B');
  } finally {
    await h.stop();
  }
});

test('scenario: agent-executed tool stays observation, not interaction', async () => {
  const h = await startHarness();
  try {
    await h.transport.publish({ kind: 'tenant-inbox' }, createSessionEvent('ask-nothing'), userContext());
    const running = await h.waitUntil((session) => (session.status === 'running' ? session : undefined), 'session running');
    await h.transport.publish({ kind: 'tenant-inbox' }, inputEvent(running.sessionId, 'ack-1', 'use-builtin-tool'), userContext());
    const events = await waitForEvents(h, (list) => list.some((event) => event.type === 'turn.completed' && event.turnSeq === 2), 'tool turn completed');
    assert.ok(events.some((event) => event.type === 'agent.output' && Boolean((event.payload as { toolStarted?: unknown }).toolStarted)));
    assert.equal(events.some((event) => event.type === 'interaction.requested'), false);
    const session = await h.session();
    assert.equal(session.openInteractions?.length ?? 0, 0);
    assert.ok(events.some((event) => event.type === 'turn.completed' && event.turnSeq === 2));
  } finally {
    await h.stop();
  }
});

test('scenario: session-scoped approval auto-resolves later matching actions at the gate', async () => {
  const h = await startHarness();
  try {
    await h.transport.publish({ kind: 'tenant-inbox' }, createSessionEvent('ask-nothing'), userContext());
    const running = await h.waitUntil((session) => (session.status === 'running' ? session : undefined), 'session running');
    await h.transport.publish({ kind: 'tenant-inbox' }, inputEvent(running.sessionId, 'ack-1', 'ask-approval'), userContext());
    const open = await h.waitUntil((session) => (session.openInteractions?.length === 1 ? session.openInteractions[0] : undefined), 'first approval');
    await h.transport.publish({ kind: 'tenant-inbox' }, interactionResponseEvent(running.sessionId, open.interactionId, { decision: 'approved', scope: 'session' }), userContext());
    const afterFirst = await waitForEvents(h, (list) => list.some((event) => event.type === 'turn.completed' && event.turnSeq === open.turnSeq), 'first approval turn completed');
    const firstResponded = afterFirst.find((event) => event.type === 'interaction.responded');
    assert.deepEqual((firstResponded?.payload as { response?: unknown }).response, { decision: 'approved', scope: 'session' });

    // A later matching action is auto-resolved by the session rule: no new interaction, no round-trip.
    await h.transport.publish({ kind: 'tenant-inbox' }, inputEvent(running.sessionId, 'ack-2', 'ask-approval'), userContext());
    const events = await waitForEvents(h, (list) => list.some((event) => event.type === 'turn.completed' && event.turnSeq === 3), 'second turn completed');
    assert.equal(events.filter((event) => event.type === 'interaction.requested').length, 1, 'no second interaction.requested');
    const secondTurnOutput = events.filter((event) => event.type === 'agent.output' && event.turnSeq === 3).at(-1);
    assert.equal((secondTurnOutput?.payload as { message?: string }).message, 'auto-approved:deleted');
  } finally {
    await h.stop();
  }
});

test('scenario: open interaction persists across pause and resume', async () => {
  const h = await startHarness();
  try {
    await h.transport.publish({ kind: 'tenant-inbox' }, createSessionEvent('ask-nothing'), userContext());
    const running = await h.waitUntil((session) => (session.status === 'running' ? session : undefined), 'session running');
    await h.transport.publish({ kind: 'tenant-inbox' }, inputEvent(running.sessionId, 'ack-1', 'ask-approval'), userContext());
    const open = await h.waitUntil((session) => (session.openInteractions?.length === 1 ? session.openInteractions[0] : undefined), 'open approval');

    await h.transport.publish({ kind: 'tenant-inbox' }, pauseRequestEvent(running.sessionId), userContext());
    const paused = await h.waitUntil((session) => (session.status === 'paused' ? session : undefined), 'session paused');
    assert.equal(paused.currentWorkerId, undefined);
    assert.equal(paused.openInteractions?.length, 1, 'open interaction persists across pause');
    assert.equal(paused.openInteractions?.[0].interactionId, open.interactionId);

    await h.transport.publish({ kind: 'tenant-inbox' }, resumeRequestEvent(running.sessionId), userContext());
    const resumed = await h.waitUntil((session) => (session.status === 'running' || session.status === 'starting' || session.status === 'queued' ? session : undefined), 'session resumed');
    assert.equal(resumed.openInteractions?.length, 1, 'open interaction still durable after resume');
  } finally {
    await h.stop();
  }
});

test('scenario: interaction response from an unauthorized principal is rejected', async () => {
  const h = await startHarness();
  try {
    await h.transport.publish({ kind: 'tenant-inbox' }, createSessionEvent('ask-nothing'), userContext());
    const running = await h.waitUntil((session) => (session.status === 'running' ? session : undefined), 'session running');
    await h.transport.publish({ kind: 'tenant-inbox' }, inputEvent(running.sessionId, 'ack-1', 'ask-approval'), userContext());
    const open = await h.waitUntil((session) => (session.openInteractions?.length === 1 ? session.openInteractions[0] : undefined), 'open approval');

    // A different principal must not be able to resolve someone else's interaction.
    await h.transport.publish({ kind: 'tenant-inbox' }, interactionResponseEvent(running.sessionId, open.interactionId, { decision: 'approved', scope: 'once' }), userContext('intruder'));
    await wait(50);
    const session = await h.session();
    assert.equal(session.openInteractions?.length, 1, 'interaction stays open after an unauthorized response');
    const events = await h.events();
    assert.equal(events.some((event) => event.type === 'interaction.responded'), false);
  } finally {
    await h.stop();
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvents(h: Harness, predicate: (events: RuntimeEvent[]) => boolean, label: string): Promise<RuntimeEvent[]> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const events = await h.events();
    if (predicate(events)) {
      return events;
    }
    await wait(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function workerRegistration(): WorkerRegisterPayload {
  return {
    sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
    labels: { agent: 'copilot' },
    capacity: 5,
    allocatable: 5
  };
}

function workerHeartbeatEvent(workerId: string): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    workerId,
    sequence: 0,
    type: 'worker.heartbeat',
    timestamp: new Date().toISOString(),
    actor: 'sidecar',
    payload: { workerId, capacity: 5, allocatable: 5, conditions: ['ready'] }
  };
}

function createSessionEvent(message: string): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    ackId: 'ack-create',
    sequence: 0,
    type: 'session.create.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: { agent: { agentSpecId: 'copilot-poc' }, input: { message }, workspace: { source: 'empty' } }
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

function interactionResponseEvent(sessionId: string, interactionId: string, response: { decision?: 'approved' | 'denied'; scope?: 'once' | 'session'; result?: unknown }): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId,
    ackId: crypto.randomUUID(),
    sequence: 0,
    type: 'interaction.respond.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: { interactionId, ...response }
  };
}

function pauseRequestEvent(sessionId: string): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId,
    ackId: crypto.randomUUID(),
    sequence: 0,
    type: 'session.pause.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: {}
  };
}

function resumeRequestEvent(sessionId: string): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    sessionId,
    ackId: crypto.randomUUID(),
    sequence: 0,
    type: 'session.resume.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: {}
  };
}

function userContext(principalId = 'demo-user'): RequestContext {
  return { principal: { principalId, type: 'user' }, connectionId: `${principalId}-connection` };
}

function serviceContext(): RequestContext {
  return { principal: { principalId: 'interaction-sidecar', type: 'service' } };
}
