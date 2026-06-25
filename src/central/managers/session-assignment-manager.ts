import type { Clock, RuntimeEvent, RuntimeStorage, SessionAssignPayload, SessionRecord } from '../../shared';
import { SessionLeaseManager } from './worker-lease-manager';
import { WorkerSelector } from './worker-selector';

export interface WorkerCommandOutput<TPayload = unknown> {
  workerId: string;
  event: RuntimeEvent<TPayload>;
}

export interface SessionAssignmentOutcome {
  session: SessionRecord;
  workerCommand?: WorkerCommandOutput<SessionAssignPayload>;
}

/**
 * Bridges queued durable sessions to replaceable worker capacity by creating the lease and the command a sidecar can act on.
 */
export class SessionAssignmentManager {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    private readonly workerSelector: WorkerSelector,
    private readonly sessionLeaseManager: SessionLeaseManager
  ) {}

  async assignReadyWorker(session: SessionRecord): Promise<SessionAssignmentOutcome> {
    const worker = this.workerSelector.select(session, await this.storage.readWorkers());
    if (!worker) {
      return { session };
    }

    const assignedSession = await this.sessionLeaseManager.assign(session, worker);
    const payload: SessionAssignPayload = {
      sessionId: assignedSession.sessionId,
      workerId: worker.workerId,
      sessionLeaseId: assignedSession.sessionLeaseId!,
      workspaceRef: assignedSession.workspaceRef,
      copilotSessionStateRef: `copilot-session:${assignedSession.sessionId}`,
      resolvedAgentSpec: assignedSession.resolvedAgentSpec
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
          sessionLeaseId: assignedSession.sessionLeaseId,
          payload
        }
      }
    };
  }
}