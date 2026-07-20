import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { InMemoryRuntimeTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { SidecarDaemon } from '../../src/sidecar/sidecar-daemon';
import type { SidecarAgentProcessAdapter, SidecarAgentProcessEventHandler, SidecarAgentProcessInput, SidecarAgentTurnResult, SidecarInteractionResponseInput, SidecarRuntimeTransport, SidecarWorkspaceAdapter, SidecarWorkspaceCaptureInput, SidecarWorkspaceHandles, SidecarWorkspaceMount, SidecarWorkspaceRestoreInput } from '../../src/sidecar/contracts';
import type { InteractionRecord, RequestContext, RuntimeChannel, RuntimeEvent, RuntimeEventHandler, RuntimeEventTransport, RuntimeSubscription, SessionRecord, SnapshotPartName, WorkerRegisterPayload } from '../../src/shared';
import { COPILOT_STORAGE_CLASS, COPILOT_WORKER_LABELS } from '../support/config-fixtures';

const TENANT = 'poc';

class SidecarInMemoryTransport implements SidecarRuntimeTransport {
  constructor(private readonly transport: RuntimeEventTransport, readonly publishedEvents: RuntimeEvent[] = []) {}
  async connect(): Promise<void> {}
  async publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void> {
    this.publishedEvents.push(event);
    await this.transport.publish(channel, event, { principal: { principalId: event.workerId ?? 'interaction-sidecar', type: 'service' } });
  }
  async subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription> {
    return this.transport.subscribe(channel, handler);
  }
  async stop(): Promise<void> {}
}

class PassthroughWorkspaceAdapter implements SidecarWorkspaceAdapter {
  mount(input: SidecarWorkspaceHandles): SidecarWorkspaceMount {
    return { workspacePath: input.workspaceRef, copilotSessionStatePath: input.agentStateRef };
  }
  async capture(_input: SidecarWorkspaceCaptureInput): Promise<SnapshotPartName[]> {
    return ['workspace', 'agent-state'];
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
    if (input.message === 'ask-approval-then-fail') {
      await emit({ type: 'interaction', payload: { interactionId: `approval-${input.turnSeq}`, kind: 'approval', request: { action: 'delete-file' } } });
      throw new Error('agent failed after requesting approval');
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
  await transport.publish({ kind: 'tenant-inbox' }, workerHeartbeatEvent(worker.workerId), serviceContext(worker.workerId));

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
      const [session] = await storage.readSessions();
      if (!session) {
        return [];
      }
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

async function waitForInteractions(
  harness: Harness,
  sessionId: string,
  check: (interactions: InteractionRecord[]) => InteractionRecord[] | InteractionRecord | undefined,
  label: string
): Promise<InteractionRecord[] | InteractionRecord> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = check(await harness.storage.readInteractionsBySession(sessionId));
    if (result !== undefined) {
      return result;
    }
    await wait(10);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(await harness.storage.readInteractionsBySession(sessionId))}`);
}

test('scenario: approval interaction survives client absence and resumes the turn', async () => {
  const h = await startHarness();
  try {
    await h.transport.publish({ kind: 'tenant-inbox' }, createSessionEvent('ask-nothing'), userContext());
    const running = await h.waitUntil((session) => (session.status === 'running' ? session : undefined), 'session running');
    // Client is not subscribed to session-events; the agent turn requests an approval.
    await h.transport.publish({ kind: 'tenant-inbox' }, inputEvent(running.sessionId, 'ack-1', 'ask-approval'), userContext());
    const open = await waitForInteractions(h, running.sessionId, (interactions) => interactions.filter((entry) => entry.state === 'open').length === 1 ? interactions.find((entry) => entry.state === 'open') : undefined, 'open approval interaction') as InteractionRecord;
    assert.equal(open.kind, 'approval');
    const eventsBefore = await h.events();
    assert.ok(eventsBefore.some((event) => event.type === 'interaction.requested'));
    assert.equal(eventsBefore.filter((event) => event.type === 'turn.completed').length, 0, 'the approval turn has not completed while the interaction is open');

    // The client comes online later and approves once.
    await h.transport.publish({ kind: 'tenant-inbox' }, interactionResponseEvent(running.sessionId, open.interactionId, { decision: 'approved', scope: 'once' }), userContext());
    const events = await waitForEvents(h, (list) => list.some((event) => event.type === 'turn.completed' && event.turnSeq === open.ownerTurnSeq), 'approval turn completed');
    assert.ok(events.some((event) => event.type === 'interaction.responded'));
    assert.equal((await h.storage.readInteractionsBySession(running.sessionId)).filter((entry) => entry.state === 'open').length, 0);
    assert.equal((await h.storage.readInteraction(open.interactionId))?.delivery.state, 'accepted');
    const finalOutput = events.filter((event) => event.type === 'agent.output').at(-1);
    assert.equal((finalOutput?.payload as { message?: string }).message, 'deleted');
  } finally {
    await h.stop();
  }
});

test('scenario: duplicate interaction response receives already_resolved acknowledgement', async () => {
  const h = await startHarness();
  try {
    const acknowledgements: RuntimeEvent[] = [];
    await h.transport.subscribe({ kind: 'client-private-inbox', clientConnectionId: 'demo-user-connection' }, async ({ event }) => {
      if (event.type === 'interaction.responded.ack') {
        acknowledgements.push(event);
      }
    });
    await h.transport.publish({ kind: 'tenant-inbox' }, createSessionEvent('ask-nothing'), userContext());
    const running = await h.waitUntil((session) => (session.status === 'running' ? session : undefined), 'session running');
    await h.transport.publish({ kind: 'tenant-inbox' }, inputEvent(running.sessionId, 'ack-1', 'ask-approval'), userContext());
    const open = await waitForInteractions(h, running.sessionId, (interactions) => interactions.find((entry) => entry.state === 'open'), 'open approval') as InteractionRecord;

    await h.transport.publish({ kind: 'tenant-inbox' }, interactionResponseEvent(running.sessionId, open.interactionId, { decision: 'approved', scope: 'once' }), userContext());
    await h.transport.publish({ kind: 'tenant-inbox' }, interactionResponseEvent(running.sessionId, open.interactionId, { decision: 'denied', scope: 'once' }), userContext());
    await waitForEvents(h, (events) => events.some((event) => event.type === 'turn.completed' && event.turnSeq === open.ownerTurnSeq), 'approved turn completed');

    assert.deepEqual(acknowledgements.map((event) => (event.payload as { status: string }).status), ['resolved', 'already_resolved']);
    assert.deepEqual((await h.storage.readInteraction(open.interactionId))?.resolution?.response, { decision: 'approved', scope: 'once' });
  } finally {
    await h.stop();
  }
});

test('scenario: owner turn failure interrupts its open interaction', async () => {
  const h = await startHarness();
  try {
    await h.transport.publish({ kind: 'tenant-inbox' }, createSessionEvent('ask-nothing'), userContext());
    const running = await h.waitUntil((session) => (session.status === 'running' ? session : undefined), 'session running');
    await h.transport.publish({ kind: 'tenant-inbox' }, inputEvent(running.sessionId, 'ack-1', 'ask-approval-then-fail'), userContext());
    const interaction = await waitForInteractions(h, running.sessionId, (interactions) => interactions.find((entry) => entry.state === 'interrupted'), 'interrupted approval') as InteractionRecord;
    const events = await waitForEvents(h, (list) => list.some((event) => event.type === 'interaction.interrupted'), 'interaction interrupted event');
    await waitForInteractions(h, running.sessionId, (interactions) => interactions.find((entry) => entry.interactionId === interaction.interactionId)?.views.every((view) => view.interruptedProjected) ? interactions : undefined, 'interruption projection committed');

    assert.equal(interaction.interruption?.reason, 'owner_turn_failed');
    assert.ok(events.some((event) => event.type === 'turn.failed'));
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
    const open = await waitForInteractions(h, running.sessionId, (interactions) => interactions.filter((entry) => entry.state === 'open').length === 2 ? interactions.filter((entry) => entry.state === 'open') : undefined, 'two open tool interactions') as InteractionRecord[];
    assert.deepEqual(open.map((entry) => entry.kind), ['tool_call', 'tool_call']);
    const toolA = open.find((entry) => entry.adapterRequestId.startsWith('tool-a'))!;
    const toolB = open.find((entry) => entry.adapterRequestId.startsWith('tool-b'))!;

    // Respond to the second-requested interaction first; each resolves independently by interactionId.
    await h.transport.publish({ kind: 'tenant-inbox' }, interactionResponseEvent(running.sessionId, toolB.interactionId, { result: 'B' }), userContext());
    await waitForInteractions(h, running.sessionId, (interactions) => interactions.filter((entry) => entry.state === 'open').length === 1 ? interactions : undefined, 'first tool resolved');
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
    assert.equal((await h.storage.readInteractionsBySession(running.sessionId)).length, 0);
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
    const open = await waitForInteractions(h, running.sessionId, (interactions) => interactions.find((entry) => entry.state === 'open'), 'first approval') as InteractionRecord;
    await h.transport.publish({ kind: 'tenant-inbox' }, interactionResponseEvent(running.sessionId, open.interactionId, { decision: 'approved', scope: 'session' }), userContext());
    const afterFirst = await waitForEvents(h, (list) => list.some((event) => event.type === 'turn.completed' && event.turnSeq === open.ownerTurnSeq), 'first approval turn completed');
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

test('scenario: a Session with an open interaction does not release its Worker lease', async () => {
  const h = await startHarness();
  try {
    await h.transport.publish({ kind: 'tenant-inbox' }, createSessionEvent('ask-nothing'), userContext());
    const running = await h.waitUntil((session) => (session.status === 'running' ? session : undefined), 'session running');
    await h.transport.publish({ kind: 'tenant-inbox' }, inputEvent(running.sessionId, 'ack-1', 'ask-approval'), userContext());
    const open = await waitForInteractions(h, running.sessionId, (interactions) => interactions.find((entry) => entry.state === 'open'), 'open approval') as InteractionRecord;

    await h.transport.publish({ kind: 'tenant-inbox' }, pauseRequestEvent(running.sessionId), userContext());
    await wait(50);
    const stillRunning = await h.session();
    assert.equal(stillRunning.status, 'running');
    assert.equal(stillRunning.currentWorkerId, running.currentWorkerId);
    assert.equal(stillRunning.sessionLeaseId, running.sessionLeaseId);
    assert.equal((await h.storage.readInteraction(open.interactionId))?.state, 'open');
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
    const open = await waitForInteractions(h, running.sessionId, (interactions) => interactions.find((entry) => entry.state === 'open'), 'open approval') as InteractionRecord;

    // A different principal must not be able to resolve someone else's interaction.
    await h.transport.publish({ kind: 'tenant-inbox' }, interactionResponseEvent(running.sessionId, open.interactionId, { decision: 'approved', scope: 'once' }), userContext('intruder'));
    await wait(50);
    assert.equal((await h.storage.readInteraction(open.interactionId))?.state, 'open', 'interaction stays open after an unauthorized response');
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
    const session = await h.session();
    const highestSequence = events.reduce((highest, event) => Math.max(highest, event.sequence), 0);
    if (predicate(events) && session.eventCursor >= highestSequence) {
      return events;
    }
    await wait(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function workerRegistration(): WorkerRegisterPayload {
  return {
    labels: COPILOT_WORKER_LABELS,
    storageClass: COPILOT_STORAGE_CLASS,
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

function userContext(principalId = 'demo-user'): RequestContext {
  return { principal: { principalId, type: 'user' }, connectionId: `${principalId}-connection` };
}

function serviceContext(principalId = 'interaction-sidecar'): RequestContext {
  return { principal: { principalId, type: 'service' } };
}
