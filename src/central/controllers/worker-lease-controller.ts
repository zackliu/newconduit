import type { RuntimeStorage, SessionRecord, WorkerRecord } from '../../shared';

export class WorkerLeaseController {
  constructor(private readonly storage: RuntimeStorage) {}

  async assign(session: SessionRecord, worker: WorkerRecord): Promise<SessionRecord> {
    const next: SessionRecord = {
      ...session,
      currentWorkerId: worker.workerId,
      workerLeaseGeneration: session.workerLeaseGeneration + 1,
      status: 'starting'
    };
    await this.storage.writeSession(next);
    return next;
  }

  assertCurrent(session: SessionRecord, generation: number): void {
    if (session.workerLeaseGeneration !== generation) {
      throw new Error(`stale worker lease generation for session ${session.sessionId}`);
    }
  }
}