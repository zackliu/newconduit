import type { Clock, RuntimeStorage, WorkerRecord } from '../../shared';

export class WorkerRegistryController {
  constructor(private readonly storage: RuntimeStorage, private readonly clock: Clock) {}

  async register(input: { tenantId: string; sidecarId: string; labels: Record<string, string>; hostingRef: string }): Promise<WorkerRecord> {
    const worker: WorkerRecord = {
      workerId: crypto.randomUUID(),
      tenantId: input.tenantId,
      capacityScope: input.tenantId,
      sidecarId: input.sidecarId,
      sidecarClass: 'copilot-process-wrapper',
      labels: input.labels,
      capacity: 1,
      allocatable: 1,
      conditions: ['ready'],
      heartbeatAt: this.clock.now(),
      currentSessionCount: 0,
      hostingRef: input.hostingRef
    };
    await this.storage.writeWorker(worker);
    return worker;
  }
}