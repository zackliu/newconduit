import { WebPubSubClient } from '@azure/web-pubsub-client';
import { SdkWebPubSubRuntimeChannelMapper } from './web-pubsub-runtime-channel';
import type {
  AgentRuntimeClientOptions,
  AgentSpecRef,
  AgentTurnError,
  AgentTurnEvent,
  AgentTurnResult,
  CreateSessionInput,
  RuntimeConnectionGrant,
  SdkRuntimeEvent,
  SdkRuntimeEventType,
  SdkSubscription,
  SessionInput,
  SessionSummary,
  SessionStatus,
  SessionEvent,
  SessionObserveOptions,
  StartSessionInput,
  TurnEventOptions,
  WaitForResultOptions
} from './types';

const CLIENT_NEGOTIATE_PATH = '/client/negotiate';
const TENANT_ID_QUERY = 'tenantId';
const CLIENT_CONNECTION_ID_QUERY = 'clientConnectionId';
const ACK_TIMEOUT_MS = 20_000;

interface PendingAcknowledgement {
  expectedType: SdkRuntimeEventType;
  timeout: NodeJS.Timeout;
  resolve(event: SdkRuntimeEvent): void;
  reject(error: Error): void;
}

export interface StartSessionResult {
  session: SessionHandle;
  turn: AgentTurn;
}

export class AgentRuntimeClient {
  readonly sessions: SessionClient;

  private readonly channelMapper: SdkWebPubSubRuntimeChannelMapper;
  private readonly pendingAcknowledgements = new Map<string, PendingAcknowledgement>();
  private readonly clientEventHandlers = new Set<(event: SdkRuntimeEvent) => void>();
  private readonly clientConnectionId = crypto.randomUUID();
  private client: WebPubSubClient | undefined;
  private clientInboxGroup: string | undefined;
  private clientPrivateInboxGroup: string | undefined;

  constructor(private readonly options: AgentRuntimeClientOptions) {
    this.channelMapper = new SdkWebPubSubRuntimeChannelMapper(options.tenantId);
    this.sessions = new SessionClient(this);
  }

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }
    const grant = await this.negotiate();
    const client = new WebPubSubClient(grant.url, {
      autoReconnect: false,
      autoRejoinGroups: false
    });
    const clientInboxGroup = grant.clientInbox ? this.channelMapper.toGroup({ kind: 'client-inbox' }) : undefined;
    const clientPrivateInboxGroup = grant.clientPrivateInbox
      ? this.channelMapper.toGroup({ kind: 'client-private-inbox', clientConnectionId: grant.clientPrivateInbox.clientConnectionId })
      : undefined;
    client.on('group-message', (message: { message: { group: string; data: unknown } }) => {
      if (message.message.group === this.clientPrivateInboxGroup) {
        this.dispatchPrivateAcknowledgement(message.message.data);
      }
      if (message.message.group === this.clientInboxGroup) {
        this.dispatchClientProjectionEvent(message.message.data);
      }
    });
    await client.start();
    if (clientInboxGroup) {
      await client.joinGroup(clientInboxGroup);
    }
    if (clientPrivateInboxGroup) {
      await client.joinGroup(clientPrivateInboxGroup);
    }
    this.clientInboxGroup = clientInboxGroup;
    this.clientPrivateInboxGroup = clientPrivateInboxGroup;
    this.client = client;
  }

  async close(): Promise<void> {
    for (const acknowledgement of this.pendingAcknowledgements.values()) {
      clearTimeout(acknowledgement.timeout);
      acknowledgement.reject(new Error('AgentRuntimeClient was closed before acknowledgement arrived'));
    }
    this.pendingAcknowledgements.clear();
    this.clientEventHandlers.clear();
    await stopWebPubSubClient(this.client);
    this.client = undefined;
    this.clientInboxGroup = undefined;
    this.clientPrivateInboxGroup = undefined;
  }

  async stop(): Promise<void> {
    await stopWebPubSubClient(this.client);
    this.clientEventHandlers.clear();
    this.client = undefined;
    this.clientInboxGroup = undefined;
    this.clientPrivateInboxGroup = undefined;
  }

  async subscribeClientEvents(handler: (event: SdkRuntimeEvent) => void): Promise<SdkSubscription> {
    await this.connect();
    this.clientEventHandlers.add(handler);
    return {
      close: async () => {
        this.clientEventHandlers.delete(handler);
      }
    };
  }

  async publishTenantEvent<TPayload>(input: {
    type: SdkRuntimeEventType;
    sessionId?: string;
    ackId?: string;
    turnSeq?: number;
    payload: TPayload;
  }): Promise<void> {
    await this.connect();
    const client = this.requireClient();
    await client.sendToGroup(this.channelMapper.toGroup({ kind: 'tenant-inbox' }), {
      eventId: crypto.randomUUID(),
      sessionId: input.sessionId,
      ackId: input.ackId,
      turnSeq: input.turnSeq,
      sequence: 0,
      type: input.type,
      timestamp: new Date().toISOString(),
      actor: 'client',
      payload: input.payload
    } satisfies SdkRuntimeEvent<TPayload>, 'json');
  }

  waitForAcknowledgement(ackId: string, expectedType: SdkRuntimeEventType): Promise<SdkRuntimeEvent> {
    return new Promise<SdkRuntimeEvent>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingAcknowledgements.delete(ackId);
        reject(new Error(`timed out waiting for ${expectedType} acknowledgement`));
      }, ACK_TIMEOUT_MS);
      this.pendingAcknowledgements.set(ackId, { expectedType, timeout, resolve, reject });
    });
  }

  async subscribeSessionEvents(input: { sessionId: string }, handler: (event: SdkRuntimeEvent) => void): Promise<SdkSubscription> {
    await this.connect();
    const client = this.requireClient();
    const group = this.channelMapper.toGroup({ kind: 'session-events', sessionId: input.sessionId });
    const listener = (message: { message: { group: string; data: unknown } }): void => {
      if (message.message.group !== group) {
        return;
      }
      handler(this.parseEvent(message.message.data));
    };
    client.on('group-message', listener);
    await client.joinGroup(group);
    return {
      close: async () => {
        client.off('group-message', listener);
      }
    };
  }

  async listSessions(): Promise<SessionSummary[]> {
    const ackId = crypto.randomUUID();
    const acknowledgement = this.waitForAcknowledgement(ackId, 'session.listed');
    await this.publishTenantEvent({
      type: 'session.list.requested',
      ackId,
      payload: {}
    });
    const listed = await acknowledgement;
    const payload = listed.payload as { sessions?: unknown[] };
    if (!Array.isArray(payload.sessions)) {
      throw new Error('central returned invalid session list');
    }
    return payload.sessions.map((session) => this.toSessionSummary(session));
  }

  async readSessionEvents(input: { sessionId: string; afterSequence?: number }): Promise<SdkRuntimeEvent[]> {
    const ackId = crypto.randomUUID();
    const acknowledgement = this.waitForAcknowledgement(ackId, 'session.events.replayed');
    await this.publishTenantEvent({
      type: 'session.events.requested',
      sessionId: input.sessionId,
      ackId,
      payload: {
        afterSequence: input.afterSequence ?? 0
      }
    });
    const replayed = await acknowledgement;
    if (replayed.sessionId !== input.sessionId) {
      throw new Error('session.events.replayed acknowledgement returned the wrong sessionId');
    }
    const payload = replayed.payload as { events?: unknown[] };
    if (!Array.isArray(payload.events)) {
      throw new Error('central returned invalid session events');
    }
    return payload.events.map((event) => this.parseEvent(event));
  }

  private async negotiate(): Promise<RuntimeConnectionGrant> {
    const url = new URL(CLIENT_NEGOTIATE_PATH, this.options.centralUrl);
    url.searchParams.set(TENANT_ID_QUERY, this.options.tenantId);
    url.searchParams.set(CLIENT_CONNECTION_ID_QUERY, this.clientConnectionId);
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) {
      throw new Error(`client negotiate failed with HTTP ${response.status}`);
    }
    return await response.json() as RuntimeConnectionGrant;
  }

  private requireClient(): WebPubSubClient {
    if (!this.client) {
      throw new Error('AgentRuntimeClient is not connected');
    }
    return this.client;
  }

  private parseEvent(data: unknown): SdkRuntimeEvent {
    if (this.isEvent(data)) {
      return data;
    }
    if (typeof data === 'string') {
      const parsed = JSON.parse(data) as unknown;
      if (this.isEvent(parsed)) {
        return parsed;
      }
    }
    throw new Error('received invalid SDK runtime event');
  }

  private dispatchClientProjectionEvent(data: unknown): void {
    let event: SdkRuntimeEvent;
    try {
      event = this.parseEvent(data);
    } catch {
      return;
    }
    for (const handler of this.clientEventHandlers) {
      handler(event);
    }
  }

  private dispatchPrivateAcknowledgement(data: unknown): void {
    let event: SdkRuntimeEvent;
    try {
      event = this.parseEvent(data);
    } catch {
      return;
    }
    if (!event.ackId) {
      return;
    }
    const pending = this.pendingAcknowledgements.get(event.ackId);
    if (!pending) {
      return;
    }
    if (event.type !== pending.expectedType) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`expected ${pending.expectedType} acknowledgement but received ${event.type}`));
      this.pendingAcknowledgements.delete(event.ackId);
      return;
    }
    clearTimeout(pending.timeout);
    pending.resolve(event);
    this.pendingAcknowledgements.delete(event.ackId);
  }

  private isEvent(data: unknown): data is SdkRuntimeEvent {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const candidate = data as Partial<SdkRuntimeEvent>;
    return typeof candidate.eventId === 'string'
      && typeof candidate.sequence === 'number'
      && typeof candidate.type === 'string'
      && typeof candidate.timestamp === 'string'
      && typeof candidate.actor === 'string'
      && 'payload' in candidate;
  }

  private toSessionSummary(value: unknown): SessionSummary {
    if (typeof value !== 'object' || value === null) {
      throw new Error('central returned invalid session summary');
    }
    const candidate = value as Record<string, unknown>;
    const resolvedAgentSpec = typeof candidate.resolvedAgentSpec === 'object' && candidate.resolvedAgentSpec !== null
      ? candidate.resolvedAgentSpec as Record<string, unknown>
      : {};
    if (typeof candidate.sessionId !== 'string'
      || typeof candidate.status !== 'string'
      || typeof resolvedAgentSpec.agentSpecId !== 'string'
      || typeof candidate.owner !== 'string'
      || typeof candidate.eventCursor !== 'number'
      || typeof candidate.createdAt !== 'string'
      || typeof candidate.updatedAt !== 'string') {
      throw new Error('central returned invalid session summary');
    }
    return {
      sessionId: candidate.sessionId,
      status: candidate.status as SessionStatus,
      agentSpecId: resolvedAgentSpec.agentSpecId,
      owner: candidate.owner,
      eventCursor: candidate.eventCursor,
      createdAt: candidate.createdAt,
      updatedAt: candidate.updatedAt
    };
  }
}

export class SessionClient {
  constructor(private readonly runtime: AgentRuntimeClient) {}

  async list(): Promise<SessionSummary[]> {
    return this.runtime.listSessions();
  }

  async start(input: StartSessionInput): Promise<StartSessionResult> {
    const ackId = crypto.randomUUID();
    const acknowledgement = this.runtime.waitForAcknowledgement(ackId, 'session.created.ack');
    await this.runtime.publishTenantEvent<CreateSessionInput>({
      type: 'session.create.requested',
      ackId,
      payload: {
        agent: this.toAgentSpecRef(input.agent),
        input: input.input,
        displayName: input.displayName,
        description: input.description,
        externalId: input.externalId,
        workspace: input.workspace ?? { source: 'empty' },
        metadata: input.metadata
      }
    });
    const created = await acknowledgement;
    const sessionId = this.requireSessionId(created);
    const turnSeq = this.requireTurnSeq(created, 'session.created.ack');
    const session = new SessionHandle(this.runtime, sessionId, 'created');
    const turn = new AgentTurn(this.runtime, sessionId, turnSeq);
    return { session, turn };
  }

  async open(sessionId: string): Promise<SessionHandle> {
    return new SessionHandle(this.runtime, sessionId, 'unknown');
  }

  private toAgentSpecRef(agent: StartSessionInput['agent']): AgentSpecRef {
    if (typeof agent === 'string') {
      return { agentSpecId: agent };
    }
    return agent;
  }

  private requireSessionId(event: SdkRuntimeEvent): string {
    if (!event.sessionId) {
      throw new Error(`${event.type} acknowledgement did not include sessionId`);
    }
    return event.sessionId;
  }

  private requireTurnSeq(event: SdkRuntimeEvent, eventType: string): number {
    if (typeof event.turnSeq !== 'number') {
      throw new Error(`${eventType} acknowledgement did not include turnSeq`);
    }
    return event.turnSeq;
  }
}

export class SessionHandle {
  constructor(private readonly runtime: AgentRuntimeClient, readonly id: string, private currentStatus: SessionStatus) {}

  async send(input: SessionInput): Promise<AgentTurn> {
    const ackId = crypto.randomUUID();
    const acknowledgement = this.runtime.waitForAcknowledgement(ackId, 'input.accepted.ack');
    await this.runtime.publishTenantEvent({
      type: 'input.received',
      sessionId: this.id,
      ackId,
      payload: {
        input
      }
    });
    const accepted = await acknowledgement;
    if (accepted.sessionId !== this.id) {
      throw new Error('input.accepted.ack acknowledgement returned the wrong sessionId');
    }
    if (typeof accepted.turnSeq !== 'number') {
      throw new Error('input.accepted.ack acknowledgement did not include turnSeq');
    }
    return new AgentTurn(this.runtime, this.id, accepted.turnSeq);
  }

  async status(): Promise<SessionStatus> {
    return this.currentStatus;
  }

  async history(afterSequence = 0): Promise<SdkRuntimeEvent[]> {
    return this.runtime.readSessionEvents({ sessionId: this.id, afterSequence });
  }

  /**
   * The single way to render a session in a UI: a typed event stream covering every turn. Live events
   * are delivered immediately (assistant.delta to append, turn.completed for the final message); prior
   * history is replayed first unless includeHistory is false. Works whether this client drives the
   * session or only observes one driven elsewhere.
   *
   * Ordering is exact: the live subscription is opened before history is read so no event is missed,
   * but live events that arrive during the history round-trip are held in a backlog and only released
   * after the whole history prefix has been emitted. History events carry sequence <= the read cursor
   * and backlogged live events carry sequence > it, so emitting history then the backlog reproduces the
   * session's causal order without any per-event sorting. eventId de-duplication drops the overlap.
   */
  async *observe(options?: SessionObserveOptions): AsyncIterable<SessionEvent> {
    const ready: SessionEvent[] = [];
    const liveBacklog: SdkRuntimeEvent[] = [];
    const seen = new Set<string>();
    let notify: (() => void) | undefined;
    let closed = false;
    let historyFlushed = options?.includeHistory === false;
    const emit = (event: SdkRuntimeEvent): void => {
      if (seen.has(event.eventId)) {
        return;
      }
      seen.add(event.eventId);
      const mapped = mapSessionEvent(event);
      if (mapped) {
        ready.push(mapped);
        notify?.();
      }
    };
    const onLive = (event: SdkRuntimeEvent): void => {
      if (historyFlushed) {
        emit(event);
      } else {
        liveBacklog.push(event);
      }
    };
    const onAbort = (): void => { closed = true; notify?.(); };
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    const subscription = await this.runtime.subscribeSessionEvents({ sessionId: this.id }, onLive);
    if (options?.includeHistory !== false) {
      try {
        for (const event of await this.runtime.readSessionEvents({ sessionId: this.id, afterSequence: 0 })) {
          emit(event);
        }
      } catch {
        // history replay is best-effort; live events still stream
      }
      historyFlushed = true;
      for (const event of liveBacklog) {
        emit(event);
      }
      liveBacklog.length = 0;
    }
    try {
      while (!closed) {
        const event = ready.shift();
        if (event) {
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => { notify = resolve; });
        notify = undefined;
      }
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
      await subscription.close();
    }
  }

  async pause(): Promise<void> {
    this.currentStatus = 'pausing';
    await this.runtime.publishTenantEvent({
      type: 'session.pause.requested',
      sessionId: this.id,
      payload: {}
    });
  }

  async resume(): Promise<void> {
    this.currentStatus = 'resuming';
    await this.runtime.publishTenantEvent({
      type: 'session.resume.requested',
      sessionId: this.id,
      payload: {}
    });
  }

  async cancel(reason?: string): Promise<void> {
    this.currentStatus = 'cancelled';
    await this.runtime.publishTenantEvent({
      type: 'session.cancel.requested',
      sessionId: this.id,
      payload: { reason }
    });
  }
}

export class AgentTurn {
  readonly id: string;

  constructor(private readonly runtime: AgentRuntimeClient, private readonly sessionId: string, readonly sequence: number) {
    this.id = `${sessionId}:${sequence}`;
  }

  async *events(options?: TurnEventOptions): AsyncIterable<AgentTurnEvent> {
    this.throwIfAborted(options?.signal);
    const pendingEvents: AgentTurnEvent[] = [];
    const seenEventIds = new Set<string>();
    let notify: (() => void) | undefined;
    let closed = false;
    const enqueue = (event: SdkRuntimeEvent): void => {
      if (seenEventIds.has(event.eventId)) {
        return;
      }
      seenEventIds.add(event.eventId);
      const turnEvent = this.toTurnEvent(event);
      if (!turnEvent) {
        return;
      }
      pendingEvents.push(turnEvent);
      if (turnEvent.type === 'turn.completed' || turnEvent.type === 'turn.failed') {
        closed = true;
      }
      notify?.();
    };
    const abortListener = (): void => {
      closed = true;
      notify?.();
    };
    options?.signal?.addEventListener('abort', abortListener, { once: true });
    pendingEvents.push({ type: 'turn.started', sessionId: this.sessionId, turnSeq: this.sequence });
    const subscription = await this.runtime.subscribeSessionEvents({ sessionId: this.sessionId }, enqueue);
    void this.runtime.readSessionEvents({ sessionId: this.sessionId, afterSequence: 0 }).then((events) => {
      for (const event of events) {
        enqueue(event);
      }
      notify?.();
    }).catch((error: unknown) => {
      pendingEvents.push({
        type: 'turn.failed',
        sessionId: this.sessionId,
        turnSeq: this.sequence,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: 'event_replay_failed'
        }
      });
      closed = true;
      notify?.();
    });
    notify?.();

    try {
      while (!closed || pendingEvents.length > 0) {
        this.throwIfAborted(options?.signal);
        const event = pendingEvents.shift();
        if (event) {
          yield event;
          continue;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
      }
    } finally {
      options?.signal?.removeEventListener('abort', abortListener);
      await subscription.close();
    }
  }

  async waitForResult(options?: WaitForResultOptions): Promise<AgentTurnResult> {
    for await (const event of this.events({ signal: options?.signal })) {
      if (event.type === 'turn.completed') {
        return event.result;
      }
      if (event.type === 'turn.failed') {
        throw new Error(event.error.message);
      }
    }
    throw new Error('agent turn ended without a result');
  }

  private toTurnEvent(event: SdkRuntimeEvent): AgentTurnEvent | undefined {
    const mapped = mapSessionEvent(event);
    if (!mapped || mapped.turnSeq !== this.sequence) {
      return undefined;
    }
    if (mapped.type === 'user.message' || mapped.type === 'status') {
      return undefined;
    }
    return mapped;
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new Error('agent turn wait was aborted');
    }
  }
}

function mapRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function mapTurnError(value: unknown): AgentTurnError {
  const error = mapRecord(value);
  return {
    message: typeof error.message === 'string' ? error.message : 'agent turn failed',
    code: typeof error.code === 'string' ? error.code : undefined,
    details: error.details
  };
}

/**
 * The one mapper from raw runtime events to the typed SessionEvent model. Both session.observe() and
 * AgentTurn.events() go through here, so there is exactly one place that knows the payload shapes.
 */
export function mapSessionEvent(event: SdkRuntimeEvent): SessionEvent | undefined {
  const sessionId = event.sessionId;
  if (!sessionId) {
    return undefined;
  }
  const payload = mapRecord(event.payload);
  const turnSeq = event.turnSeq ?? (typeof payload.turnSeq === 'number' ? payload.turnSeq : 0);
  if (event.type === 'session.created' || event.type === 'input.accepted') {
    const input = mapRecord(payload.input);
    return typeof input.message === 'string' ? { type: 'user.message', sessionId, turnSeq, text: input.message } : undefined;
  }
  if (event.type === 'status.changed' || event.type === 'session.status.updated') {
    return typeof payload.status === 'string' ? { type: 'status', sessionId, turnSeq, status: payload.status as SessionStatus } : undefined;
  }
  if (event.type === 'turn.completed') {
    const result = mapRecord(payload.result);
    return { type: 'turn.completed', sessionId, turnSeq, result: { sessionId, turnSeq, message: typeof result.message === 'string' ? result.message : undefined, output: 'output' in result ? result.output : undefined } };
  }
  if (event.type === 'turn.failed') {
    return { type: 'turn.failed', sessionId, turnSeq, error: mapTurnError(payload.error) };
  }
  if (event.type !== 'agent.output') {
    return undefined;
  }
  if (typeof payload.delta === 'string') {
    return { type: 'assistant.delta', sessionId, turnSeq, text: payload.delta };
  }
  if (typeof payload.progress === 'string') {
    return { type: 'agent.progress', sessionId, turnSeq, message: payload.progress };
  }
  const toolStarted = mapRecord(payload.toolStarted);
  if (typeof toolStarted.toolCallId === 'string' && typeof toolStarted.toolName === 'string') {
    return { type: 'tool.started', sessionId, turnSeq, toolCallId: toolStarted.toolCallId, toolName: toolStarted.toolName, inputSummary: toolStarted.inputSummary };
  }
  const toolCompleted = mapRecord(payload.toolCompleted);
  if (typeof toolCompleted.toolCallId === 'string' && typeof toolCompleted.toolName === 'string') {
    return { type: 'tool.completed', sessionId, turnSeq, toolCallId: toolCompleted.toolCallId, toolName: toolCompleted.toolName, outputSummary: toolCompleted.outputSummary };
  }
  if (payload.approvalRequested) {
    return { type: 'approval.requested', sessionId, turnSeq, approval: payload.approvalRequested };
  }
  if (payload.error) {
    return { type: 'agent.internal', sessionId, turnSeq, label: 'agent.error', detail: payload.error };
  }
  const internalEvent = mapRecord(payload.internalEvent);
  if (typeof internalEvent.type === 'string') {
    return { type: 'agent.internal', sessionId, turnSeq, label: internalEvent.type, detail: internalEvent.data };
  }
  return undefined;
}


async function stopWebPubSubClient(client: WebPubSubClient | undefined): Promise<void> {
  client?.stop();
}