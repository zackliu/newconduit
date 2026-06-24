import type { RuntimeEvent, WorkerRecord } from '../../shared';

export class WorkerRegistrationController {
  createRegisterEvent(worker: WorkerRecord): RuntimeEvent<WorkerRecord> {
    return {
      eventId: crypto.randomUUID(),
      workerId: worker.workerId,
      sequence: 0,
      type: 'worker.register',
      timestamp: new Date().toISOString(),
      actor: 'sidecar',
      payload: worker
    };
  }
}