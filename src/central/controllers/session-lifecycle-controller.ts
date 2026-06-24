import type { Clock, ResolvedAgentSpec, SessionRecord, SessionStatus, RuntimeStorage } from '../../shared';

export class SessionLifecycleController {
  constructor(private readonly storage: RuntimeStorage, private readonly clock: Clock) {}

  async create(input: { tenantId: string; owner: string; resolvedAgentSpec: ResolvedAgentSpec; workspaceRef: string }): Promise<SessionRecord> {
    const now = this.clock.now();
    const session: SessionRecord = {
      sessionId: crypto.randomUUID(),
      tenantId: input.tenantId,
      owner: input.owner,
      resolvedAgentSpec: input.resolvedAgentSpec,
      status: 'created',
      workerLeaseGeneration: 0,
      eventCursor: 0,
      workspaceRef: input.workspaceRef,
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
}