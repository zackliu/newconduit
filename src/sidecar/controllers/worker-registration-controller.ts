import type { RuntimeEvent, WorkerRegisterPayload } from '../../shared';
import type { WorkerRegistrationEventFactory } from '../contracts';

export class WorkerRegistrationController implements WorkerRegistrationEventFactory {
  createRegisterEvent(payload: WorkerRegisterPayload): RuntimeEvent<WorkerRegisterPayload> {
    return {
      eventId: crypto.randomUUID(),
      sequence: 0,
      type: 'worker.register',
      timestamp: new Date().toISOString(),
      actor: 'sidecar',
      payload
    };
  }
}