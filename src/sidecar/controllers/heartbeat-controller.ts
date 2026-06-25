import type { RuntimeEvent, WorkerHeartbeatPayload, WorkerIdentityPayload } from '../../shared';

/**
 * Produces sidecar lifecycle signals that let central keep worker capacity fresh without knowing sidecar internals.
 */
export class HeartbeatController {
  createHeartbeat(payload: WorkerHeartbeatPayload): RuntimeEvent<WorkerHeartbeatPayload> {
    return {
      eventId: crypto.randomUUID(),
      workerId: payload.workerId,
      sequence: 0,
      type: 'worker.heartbeat',
      timestamp: new Date().toISOString(),
      actor: 'sidecar',
      payload
    };
  }

  createDrainRequested(payload: WorkerIdentityPayload): RuntimeEvent<WorkerIdentityPayload> {
    return {
      eventId: crypto.randomUUID(),
      workerId: payload.workerId,
      sequence: 0,
      type: 'worker.drain.requested',
      timestamp: new Date().toISOString(),
      actor: 'sidecar',
      payload
    };
  }

  createCloseRequested(payload: WorkerIdentityPayload): RuntimeEvent<WorkerIdentityPayload> {
    return {
      eventId: crypto.randomUUID(),
      workerId: payload.workerId,
      sequence: 0,
      type: 'worker.close.requested',
      timestamp: new Date().toISOString(),
      actor: 'sidecar',
      payload
    };
  }
}