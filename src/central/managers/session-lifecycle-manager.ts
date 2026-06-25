import type { Clock, ResolvedAgentSpec, RuntimeStorage, SessionRecord, SessionStatus } from '../../shared';

/**
 * Owns the durable session record transitions that describe where a session is in the runtime lifecycle.
 */
export class SessionLifecycleManager {
  constructor(private readonly storage: RuntimeStorage, private readonly clock: Clock) {}

  async create(input: { tenantId: string; owner: string; resolvedAgentSpec: ResolvedAgentSpec; workspaceRef: string; nextTurnSeq: number }): Promise<SessionRecord> {
    const now = this.clock.now();
    const session: SessionRecord = {
      sessionId: crypto.randomUUID(),
      tenantId: input.tenantId,
      owner: input.owner,
      resolvedAgentSpec: input.resolvedAgentSpec,
      status: 'created',
      eventCursor: 0,
      nextTurnSeq: input.nextTurnSeq,
      workspaceRef: input.workspaceRef,
      lastEventUpdatedAt: now,
      createdAt: now,
      updatedAt: now
    };
    await this.storage.writeSession(session);
    return session;
  }

  async transition(session: SessionRecord, status: SessionStatus, reason?: string): Promise<SessionRecord> {
    const next = { ...session, status, lifecycleReason: reason, updatedAt: this.clock.now() };
    await this.storage.writeSession(next);
    return next;
  }

  async transitionAfterEvent(session: SessionRecord, status: SessionStatus, sequence: number, timestamp: string, reason?: string): Promise<SessionRecord> {
    const next = { ...session, status, lifecycleReason: reason, eventCursor: sequence, lastEventUpdatedAt: timestamp, updatedAt: this.clock.now() };
    await this.storage.writeSession(next);
    return next;
  }

  async pauseAfterEvent(session: SessionRecord, sequence: number, timestamp: string, reason?: string): Promise<SessionRecord> {
    const next = {
      ...session,
      status: 'paused' as const,
      currentWorkerId: undefined,
      sessionLeaseId: undefined,
      lifecycleReason: reason,
      eventCursor: sequence,
      lastEventUpdatedAt: timestamp,
      updatedAt: this.clock.now()
    };
    await this.storage.writeSession(next);
    return next;
  }

  async allocateNextTurn(session: SessionRecord): Promise<{ session: SessionRecord; turnSeq: number }> {
    const turnSeq = session.nextTurnSeq;
    const next = { ...session, nextTurnSeq: turnSeq + 1, updatedAt: this.clock.now() };
    await this.storage.writeSession(next);
    return { session: next, turnSeq };
  }

  async advanceEventCursor(session: SessionRecord, sequence: number): Promise<SessionRecord> {
    const now = this.clock.now();
    const next = { ...session, eventCursor: sequence, lastEventUpdatedAt: now, updatedAt: now };
    await this.storage.writeSession(next);
    return next;
  }
}