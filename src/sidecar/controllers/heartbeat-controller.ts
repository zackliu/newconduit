import type { RuntimeEvent } from '../../shared';

export class HeartbeatController {
  createHeartbeat(workerId: string): RuntimeEvent<{ workerId: string }> {
    return {
      eventId: crypto.randomUUID(),
      workerId,
      sequence: 0,
      type: 'worker.heartbeat',
      timestamp: new Date().toISOString(),
      actor: 'sidecar',
      payload: { workerId }
    };
  }
}