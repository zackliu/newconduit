import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, type RuntimeEvent, type WorkerCondition, type WorkerHeartbeatPayload, type WorkerIdentityPayload, type WorkerRegisterPayload } from '../../shared';
import { WorkerManager } from '../managers';

export class WorkerRuntimeEventController {
  constructor(private readonly workerManager: WorkerManager) {}

  async handleRuntimeEvent(tenantId: string, event: RuntimeEvent): Promise<boolean> {
    switch (event.type) {
      case 'worker.register': {
        const payload = this.parseWorkerRegisterPayload(event.payload);
        await this.workerManager.register({ tenantId, ...payload });
        return true;
      }
      case 'worker.heartbeat': {
        const payload = this.parseWorkerHeartbeatPayload(event.payload);
        await this.workerManager.heartbeat(payload);
        return true;
      }
      case 'worker.drain.requested': {
        const payload = this.parseWorkerIdentityPayload(event.payload);
        await this.workerManager.drain(payload);
        return true;
      }
      case 'worker.close.requested': {
        const payload = this.parseWorkerIdentityPayload(event.payload);
        await this.workerManager.close(payload);
        return true;
      }
      default:
        return false;
    }
  }

  private parseWorkerRegisterPayload(payload: unknown): WorkerRegisterPayload {
    if (!this.isWorkerRegisterPayload(payload)) {
      throw new Error('invalid worker.register payload');
    }
    return payload;
  }

  private isWorkerRegisterPayload(payload: unknown): payload is WorkerRegisterPayload {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }
    const candidate = payload as Partial<WorkerRegisterPayload>;
    return typeof candidate.sidecarId === 'string'
      && candidate.sidecarClass === COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS
      && this.isStringRecord(candidate.labels)
      && typeof candidate.capacity === 'number'
      && typeof candidate.allocatable === 'number';
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
      && typeof candidate.generation === 'number'
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
    return typeof candidate.workerId === 'string' && typeof candidate.generation === 'number';
  }

  private isWorkerCondition(condition: unknown): condition is WorkerCondition {
    return condition === 'ready' || condition === 'busy' || condition === 'draining' || condition === 'disconnected';
  }

  private isStringRecord(value: unknown): value is Record<string, string> {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    return Object.values(value).every((entry) => typeof entry === 'string');
  }
}