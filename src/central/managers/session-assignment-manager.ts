import type { Clock, RuntimeEvent, RuntimeStorage, SessionAssignPayload, SessionRecord } from '../../shared';
import { WorkerLeaseManager } from './worker-lease-manager';
import { WorkerSelector } from './worker-selector';

export interface WorkerCommandOutput<TPayload = unknown> {
  workerId: string;
  event: RuntimeEvent<TPayload>;
}

export interface SessionAssignmentOutcome {
  session: SessionRecord;
  workerCommand?: WorkerCommandOutput<SessionAssignPayload>;
}

export class SessionAssignmentManager {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    private readonly workerSelector: WorkerSelector,
    private readonly workerLeaseManager: WorkerLeaseManager
  ) {}

  async assignReadyWorker(session: SessionRecord): Promise<SessionAssignmentOutcome> {
    const worker = this.workerSelector.select(session, await this.storage.readWorkers());
    if (!worker) {
      return { session };
    }

    const assignedSession = await this.workerLeaseManager.assign(session, worker);
    const payload: SessionAssignPayload = {
      sessionId: assignedSession.sessionId,
      workerId: worker.workerId,
      workerLeaseGeneration: assignedSession.workerLeaseGeneration,
      workspaceRef: assignedSession.workspaceRef,
      resolvedAgentSpec: {
        agentSpecId: assignedSession.resolvedAgentSpec.agentSpecId,
        sidecarClass: assignedSession.resolvedAgentSpec.sidecarClass,
        digest: assignedSession.resolvedAgentSpec.digest
      }
    };
    return {
      session: assignedSession,
      workerCommand: {
        workerId: worker.workerId,
        event: {
          eventId: crypto.randomUUID(),
          sessionId: assignedSession.sessionId,
          workerId: worker.workerId,
          sequence: assignedSession.eventCursor + 1,
          type: 'session.assign',
          timestamp: this.clock.now(),
          actor: 'central',
          workerLeaseGeneration: assignedSession.workerLeaseGeneration,
          payload
        }
      }
    };
  }
}