import type { Clock, ResolvedAgentSpec, RuntimeStorage, SessionDelegationBinding, SessionRecord, SessionStatus } from '../../../shared';

/**
 * Invoked exactly once when a session first crosses into a terminal status, from any transition path. Lets an owner
 * (e.g. case-pairing binding revocation) react to session closure without the lifecycle writer knowing that concern.
 * Must be idempotent and self-contained: it is best-effort and its failure never rolls back the durable transition.
 */
export type SessionTerminalHook = (session: SessionRecord) => Promise<void>;

const TERMINAL_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['completed', 'cancelled', 'failed']);

/**
 * Owns the durable session record transitions that describe where a session is in the runtime lifecycle.
 */
export class SessionLifecycleManager {
  constructor(private readonly storage: RuntimeStorage, private readonly clock: Clock, private readonly onTerminal?: SessionTerminalHook) {}

  async create(input: { sessionId?: string; tenantId: string; owner: string; resolvedAgentSpec: ResolvedAgentSpec; workspaceRef: string; delegationBinding?: SessionDelegationBinding; requiredWorkerLabels?: Record<string, string> }): Promise<SessionRecord> {
    const now = this.clock.now();
    const session: SessionRecord = {
      sessionId: input.sessionId ?? crypto.randomUUID(),
      tenantId: input.tenantId,
      owner: input.owner,
      resolvedAgentSpec: input.resolvedAgentSpec,
      delegationBinding: input.delegationBinding,
      requiredWorkerLabels: input.requiredWorkerLabels,
      status: 'created',
      eventCursor: 0,
      nextTurnSeq: 1,
      workspaceRef: input.workspaceRef,
      lastEventUpdatedAt: now,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.storage.createSession(session);
    const actual = created.session;
    if (actual.tenantId !== input.tenantId
      || actual.owner !== input.owner
      || actual.resolvedAgentSpec.digest !== input.resolvedAgentSpec.digest
      || actual.workspaceRef !== input.workspaceRef
      || JSON.stringify(actual.delegationBinding) !== JSON.stringify(input.delegationBinding)
      || JSON.stringify(actual.requiredWorkerLabels) !== JSON.stringify(input.requiredWorkerLabels)) {
      throw new Error(`session ${session.sessionId} exists with a different create intent`);
    }
    return actual;
  }

  async transition(session: SessionRecord, status: SessionStatus, reason?: string): Promise<SessionRecord> {
    const next = { ...session, status, lifecycleReason: reason, updatedAt: this.clock.now() };
    await this.storage.writeSession(next);
    await this.fireTerminalHook(session.status, next);
    return next;
  }

  async transitionAfterEvent(session: SessionRecord, status: SessionStatus, sequence: number, timestamp: string, reason?: string): Promise<SessionRecord> {
    const next = { ...session, status, lifecycleReason: reason, eventCursor: sequence, lastEventUpdatedAt: timestamp, updatedAt: this.clock.now() };
    await this.storage.writeSession(next);
    await this.fireTerminalHook(session.status, next);
    return next;
  }

  async pauseAfterEvent(session: SessionRecord, sequence: number, timestamp: string, reason?: string, latestSnapshotRef?: string): Promise<SessionRecord> {
    const next = {
      ...session,
      status: 'paused' as const,
      currentWorkerId: undefined,
      sessionLeaseId: undefined,
      latestSnapshotRef: latestSnapshotRef ?? session.latestSnapshotRef,
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

  async acceptTurnAfterEvent(session: SessionRecord, turnSeq: number, sequence: number, timestamp: string, status: Extract<SessionStatus, 'queued' | 'running'>, reason?: string): Promise<SessionRecord> {
    if (session.nextTurnSeq !== turnSeq) {
      throw new Error(`session ${session.sessionId} expected turn ${session.nextTurnSeq}, received ${turnSeq}`);
    }
    const next: SessionRecord = {
      ...session,
      status,
      lifecycleReason: reason,
      nextTurnSeq: turnSeq + 1,
      eventCursor: sequence,
      lastEventUpdatedAt: timestamp,
      updatedAt: this.clock.now()
    };
    await this.storage.writeSession(next);
    return next;
  }

  async advanceEventCursor(session: SessionRecord, sequence: number): Promise<SessionRecord> {
    const now = this.clock.now();
    const next = { ...session, eventCursor: sequence, lastEventUpdatedAt: now, updatedAt: now };
    await this.storage.writeSession(next);
    return next;
  }

  /**
   * Fire the terminal hook exactly on the edge from a non-terminal to a terminal status, so it runs once per closure
   * regardless of which caller drove the transition and independent of whether the session ever had a delegation.
   */
  private async fireTerminalHook(previousStatus: SessionStatus, next: SessionRecord): Promise<void> {
    if (this.onTerminal && TERMINAL_STATUSES.has(next.status) && !TERMINAL_STATUSES.has(previousStatus)) {
      await this.onTerminal(next);
    }
  }

}