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
  SessionStatus,
  StartSessionInput,
  TurnEventOptions,
  WaitForResultOptions
} from './types';

const CLIENT_NEGOTIATE_PATH = '/client/negotiate';
const TENANT_ID_QUERY = 'tenantId';
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
  private client: WebPubSubClient | undefined;
  private clientInboxGroup: string | undefined;

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
    const clientInboxGroup = grant.clientInbox
      ? this.channelMapper.toGroup({ kind: 'client-inbox', principalId: grant.clientInbox.principalId })
      : undefined;
    client.on('group-message', (message: { message: { group: string; data: unknown } }) => {
      if (message.message.group !== this.clientInboxGroup) {
        return;
      }
      this.dispatchAcknowledgement(message.message.data);
    });
    await client.start();
    if (clientInboxGroup) {
      await client.joinGroup(clientInboxGroup);
    }
    this.clientInboxGroup = clientInboxGroup;
    this.client = client;
  }

  async close(): Promise<void> {
    for (const acknowledgement of this.pendingAcknowledgements.values()) {
      clearTimeout(acknowledgement.timeout);
      acknowledgement.reject(new Error('AgentRuntimeClient was closed before acknowledgement arrived'));
    }
    this.pendingAcknowledgements.clear();
    await stopWebPubSubClient(this.client);
    this.client = undefined;
    this.clientInboxGroup = undefined;
  }

  async stop(): Promise<void> {
    await stopWebPubSubClient(this.client);
    this.client = undefined;
    this.clientInboxGroup = undefined;
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

  private async negotiate(): Promise<RuntimeConnectionGrant> {
    const url = new URL(CLIENT_NEGOTIATE_PATH, this.options.centralUrl);
    url.searchParams.set(TENANT_ID_QUERY, this.options.tenantId);
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

  private dispatchAcknowledgement(data: unknown): void {
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
}

export class SessionClient {
  constructor(private readonly runtime: AgentRuntimeClient) {}

  async start(input: StartSessionInput): Promise<StartSessionResult> {
    const ackId = crypto.randomUUID();
    const acknowledgement = this.runtime.waitForAcknowledgement(ackId, 'session.created');
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
    const turnSeq = this.requireTurnSeq(created, 'session.created');
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
    const acknowledgement = this.runtime.waitForAcknowledgement(ackId, 'input.accepted');
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
      throw new Error('input.accepted acknowledgement returned the wrong sessionId');
    }
    if (typeof accepted.turnSeq !== 'number') {
      throw new Error('input.accepted acknowledgement did not include turnSeq');
    }
    return new AgentTurn(this.runtime, this.id, accepted.turnSeq);
  }

  async status(): Promise<SessionStatus> {
    return this.currentStatus;
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
    let notify: (() => void) | undefined;
    let closed = false;
    const abortListener = (): void => {
      closed = true;
      notify?.();
    };
    options?.signal?.addEventListener('abort', abortListener, { once: true });
    const subscription = await this.runtime.subscribeSessionEvents({ sessionId: this.sessionId }, (event) => {
      const turnEvent = this.toTurnEvent(event);
      if (!turnEvent) {
        return;
      }
      pendingEvents.push(turnEvent);
      if (turnEvent.type === 'turn.completed' || turnEvent.type === 'turn.failed') {
        closed = true;
      }
      notify?.();
    });

    pendingEvents.push({ type: 'turn.started', sessionId: this.sessionId, turnSeq: this.sequence });
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
    if (event.sessionId !== this.sessionId) {
      return undefined;
    }
    const payload = this.toRecord(event.payload);
    const payloadTurnSeq = typeof payload.turnSeq === 'number' ? payload.turnSeq : undefined;
    if (event.turnSeq !== this.sequence && payloadTurnSeq !== this.sequence) {
      return undefined;
    }
    if (event.type !== 'agent.output') {
      return undefined;
    }
    if (typeof payload.delta === 'string') {
      return { type: 'assistant.delta', sessionId: this.sessionId, turnSeq: this.sequence, text: payload.delta };
    }
    if (typeof payload.progress === 'string') {
      return { type: 'agent.progress', sessionId: this.sessionId, turnSeq: this.sequence, message: payload.progress };
    }
    if (payload.error) {
      return { type: 'turn.failed', sessionId: this.sessionId, turnSeq: this.sequence, error: this.toTurnError(payload.error) };
    }
    const result: AgentTurnResult = {
      sessionId: this.sessionId,
      turnSeq: this.sequence,
      message: typeof payload.message === 'string' ? payload.message : undefined,
      output: 'output' in payload ? payload.output : payload
    };
    return { type: 'turn.completed', sessionId: this.sessionId, turnSeq: this.sequence, result };
  }

  private toRecord(value: unknown): Record<string, unknown> {
    if (typeof value === 'object' && value !== null) {
      return value as Record<string, unknown>;
    }
    return {};
  }

  private toTurnError(value: unknown): AgentTurnError {
    const error = this.toRecord(value);
    return {
      message: typeof error.message === 'string' ? error.message : 'agent turn failed',
      code: typeof error.code === 'string' ? error.code : undefined,
      details: error.details
    };
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new Error('agent turn wait was aborted');
    }
  }
}

async function stopWebPubSubClient(client: WebPubSubClient | undefined): Promise<void> {
  client?.stop();
}