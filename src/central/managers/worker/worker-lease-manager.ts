import type { RuntimeStorage, SessionRecord, WorkerRecord } from '../../../shared';

/**
 * Protects the session-to-worker binding so commands and agent events can be checked against the current session lease.
 */
export class SessionLeaseManager {
  constructor(private readonly storage: RuntimeStorage) {}

  async assign(session: SessionRecord, worker: WorkerRecord): Promise<SessionRecord> {
    const next: SessionRecord = {
      ...session,
      currentWorkerId: worker.workerId,
      sessionLeaseId: crypto.randomUUID(),
      status: 'starting'
    };
    await this.storage.writeSession(next);
    return next;
  }

  assertCurrent(session: SessionRecord, sessionLeaseId: string): void {
    if (session.sessionLeaseId !== sessionLeaseId) {
      throw new Error(`stale session lease for session ${session.sessionId}`);
    }
  }
}