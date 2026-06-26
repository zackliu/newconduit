import type { Clock, RuntimeEvent, RuntimeStorage, SessionAssignPayload, SessionRecord } from '../../shared';
import { SnapshotManager } from './snapshot-manager';
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
    private readonly sessionLeaseManager: SessionLeaseManager,
    private readonly snapshotManager: SnapshotManager
  ) {}

  async assignReadyWorker(session: SessionRecord): Promise<SessionAssignmentOutcome> {
    const worker = this.workerSelector.select(session, await this.storage.readWorkers());
    if (!worker) {
      return { session };
    }

    const assignedSession = await this.sessionLeaseManager.assign(session, worker);
    await this.storage.writeWorker({
      ...worker,
      allocatable: Math.max(0, worker.allocatable - 1),
      conditions: worker.allocatable - 1 > 0 ? worker.conditions : ['busy'],
      currentSessionCount: worker.currentSessionCount + 1,
      updatedAt: this.clock.now()
    });
    const restore = await this.snapshotManager.planRestore(assignedSession);
    const payload: SessionAssignPayload = {
      sessionId: assignedSession.sessionId,
      workerId: worker.workerId,
      sessionLeaseId: assignedSession.sessionLeaseId!,
      workspaceRef: assignedSession.workspaceRef,
      copilotSessionStateRef: `copilot-session:${assignedSession.sessionId}`,
      resolvedAgentSpec: assignedSession.resolvedAgentSpec,
      ...(restore ? { restore } : {})
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