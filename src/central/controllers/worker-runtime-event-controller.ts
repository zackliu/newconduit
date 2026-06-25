import { type RuntimeEvent, type RuntimeEventTransport, type WorkerCondition, type WorkerHeartbeatPayload, type WorkerIdentityPayload } from '../../shared';
import { SessionLifecycleReconciler, WorkerManager } from '../managers';

export interface WorkerRuntimeEventOutcome {
  handled: boolean;
}

/**
 * Accepts worker lifecycle signals from sidecars and turns them into tenant-owned capacity state that assignment can trust.
 */
export class WorkerRuntimeEventController {
  constructor(private readonly workerManager: WorkerManager, private readonly sessionLifecycleReconciler?: SessionLifecycleReconciler, private readonly eventTransport?: RuntimeEventTransport) {}

  async handleRuntimeEvent(tenantId: string, event: RuntimeEvent): Promise<WorkerRuntimeEventOutcome> {
    switch (event.type) {
      case 'worker.heartbeat': {
        const payload = this.parseWorkerHeartbeatPayload(event.payload);
        await this.workerManager.heartbeat(payload);
        await this.reconcileSessions();
        return { handled: true };
      }
      case 'worker.drain.requested': {
        const payload = this.parseWorkerIdentityPayload(event.payload);
        await this.workerManager.drain(payload);
        return { handled: true };
      }
      case 'worker.close.requested': {
        const payload = this.parseWorkerIdentityPayload(event.payload);
        await this.workerManager.close(payload);
        return { handled: true };
      }
      default:
        return { handled: false };
    }
  }

  async reconcileSessions(): Promise<void> {
    const outcome = await this.sessionLifecycleReconciler?.reconcile();
    if (!outcome || !this.eventTransport) {
      return;
    }
    for (const command of outcome.workerCommands) {
      await this.eventTransport.publish({ kind: 'worker-commands', workerId: command.workerId }, command.event);
    }
  }

  private parseWorkerHeartbeatPayload(payload: unknown): WorkerHeartbeatPayload {
    if (!this.isWorkerHeartbeatPayload(payload)) {
      throw new Error('invalid worker.heartbeat payload');
    }
    return payload;
  }

  private isWorkerHeartbeatPayload(payload: unknown): payload is WorkerHeartbeatPayload {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }
    const candidate = payload as Partial<WorkerHeartbeatPayload>;
    return typeof candidate.workerId === 'string'
      && typeof candidate.capacity === 'number'
      && typeof candidate.allocatable === 'number'
      && Array.isArray(candidate.conditions)
      && candidate.conditions.every((condition) => this.isWorkerCondition(condition));
  }

  private parseWorkerIdentityPayload(payload: unknown): WorkerIdentityPayload {
    if (!this.isWorkerIdentityPayload(payload)) {
      throw new Error('invalid worker identity payload');
    }
    return payload;
  }

  private isWorkerIdentityPayload(payload: unknown): payload is WorkerIdentityPayload {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }
    const candidate = payload as Partial<WorkerIdentityPayload>;
    return typeof candidate.workerId === 'string';
  }

  private isWorkerCondition(condition: unknown): condition is WorkerCondition {
    return condition === 'ready' || condition === 'busy' || condition === 'draining' || condition === 'disconnected';
  }

}