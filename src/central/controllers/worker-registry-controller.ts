import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, type Clock, type RuntimeEvent, type RuntimeStorage, type SessionRecord, type WorkerCondition, type WorkerHeartbeatPayload, type WorkerIdentityPayload, type WorkerRecord, type WorkerRegisterPayload } from '../../shared';

const DEFAULT_KEEPALIVE_TTL_MS = 30_000;

export class WorkerRegistryController {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    private readonly keepaliveTtlMs = DEFAULT_KEEPALIVE_TTL_MS
  ) {}

  async handleRuntimeEvent(tenantId: string, event: RuntimeEvent): Promise<boolean> {
    switch (event.type) {
      case 'worker.register': {
        const payload = this.parseWorkerRegisterPayload(event.payload);
        await this.register({ tenantId, ...payload });
        return true;
      }
      case 'worker.heartbeat': {
        const payload = this.parseWorkerHeartbeatPayload(event.payload);
        await this.heartbeat(payload);
        return true;
      }
      case 'worker.drain.requested': {
        const payload = this.parseWorkerIdentityPayload(event.payload);
        await this.drain(payload);
        return true;
      }
      case 'worker.close.requested': {
        const payload = this.parseWorkerIdentityPayload(event.payload);
        await this.close(payload);
        return true;
      }
      default:
        return false;
    }
  }

  async register(input: { tenantId: string } & WorkerRegisterPayload): Promise<WorkerRecord> {
    const now = this.clock.now();
    const worker: WorkerRecord = {
      workerId: crypto.randomUUID(),
      tenantId: input.tenantId,
      capacityScope: input.tenantId,
      sidecarId: input.sidecarId,
      sidecarClass: input.sidecarClass,
      labels: input.labels,
      capacity: input.capacity,
      allocatable: input.allocatable,
      conditions: ['ready'],
      lifecycleState: 'active',
      heartbeatAt: now,
      expiresAt: this.expiresAt(now),
      generation: 1,
      currentSessionCount: 0,
      updatedAt: now
    };
    await this.storage.writeWorker(worker);
    await this.appendWorkerEvent(worker, 'worker.registered', {
      sidecarId: worker.sidecarId,
      sidecarClass: worker.sidecarClass,
      labels: worker.labels,
      capacity: worker.capacity,
      allocatable: worker.allocatable
    });
    return worker;
  }

  async heartbeat(input: WorkerHeartbeatPayload): Promise<WorkerRecord> {
    const worker = await this.requireWorker(input.workerId);
    if (!this.isCurrentActiveWorker(worker, input.generation)) {
      await this.appendHeartbeatRejected(worker, input.generation, 'stale-worker-generation');
      return worker;
    }

    const now = this.clock.now();
    const next: WorkerRecord = {
      ...worker,
      capacity: input.capacity,
      allocatable: input.allocatable,
      conditions: this.normalizeActiveConditions(input.conditions),
      heartbeatAt: now,
      expiresAt: this.expiresAt(now),
      updatedAt: now
    };
    await this.storage.writeWorker(next);
    await this.appendWorkerEvent(next, 'worker.heartbeat', {
      capacity: next.capacity,
      allocatable: next.allocatable,
      conditions: next.conditions,
      heartbeatAt: next.heartbeatAt,
      expiresAt: next.expiresAt
    });
    return next;
  }

  async drain(input: WorkerIdentityPayload): Promise<WorkerRecord> {
    const worker = await this.requireWorker(input.workerId);
    this.assertCurrentActiveWorker(worker, input.generation);
    const next: WorkerRecord = {
      ...worker,
      allocatable: 0,
      conditions: ['draining'],
      updatedAt: this.clock.now()
    };
    await this.storage.writeWorker(next);
    await this.appendWorkerEvent(next, 'worker.draining', { generation: next.generation });
    return next;
  }

  async close(input: WorkerIdentityPayload): Promise<WorkerRecord> {
    const worker = await this.requireWorker(input.workerId);
    this.assertCurrentActiveWorker(worker, input.generation);
    return this.terminate(worker, 'closed', 'worker_closed', 'worker.closed');
  }

  async expireWorkers(): Promise<WorkerRecord[]> {
    const now = Date.parse(this.clock.now());
    const workers = await this.storage.readWorkers();
    const expiredWorkers = workers.filter((worker) => worker.lifecycleState === 'active' && Date.parse(worker.expiresAt) <= now);
    const terminatedWorkers: WorkerRecord[] = [];
    for (const worker of expiredWorkers) {
      terminatedWorkers.push(await this.terminate(worker, 'expired', 'worker_keepalive_expired', 'worker.expired'));
    }
    return terminatedWorkers;
  }

  private async terminate(worker: WorkerRecord, lifecycleState: 'closed' | 'expired', reason: string, eventType: 'worker.closed' | 'worker.expired'): Promise<WorkerRecord> {
    const now = this.clock.now();
    const next: WorkerRecord = {
      ...worker,
      allocatable: 0,
      conditions: ['disconnected'],
      lifecycleState,
      terminalReason: reason,
      updatedAt: now
    };
    await this.storage.writeWorker(next);
    await this.appendWorkerEvent(next, eventType, { reason });
    await this.failLeasedSessions(next);
    return next;
  }

  private async failLeasedSessions(worker: WorkerRecord): Promise<void> {
    const sessions = await this.storage.readSessions();
    const leasedSessions = sessions.filter((session) => this.hasActiveLease(session, worker.workerId));
    for (const session of leasedSessions) {
      const sequence = session.eventCursor + 1;
      await this.storage.appendEvent({
        eventId: crypto.randomUUID(),
        sessionId: session.sessionId,
        workerId: worker.workerId,
        sequence,
        type: 'worker.lease.lost',
        timestamp: this.clock.now(),
        actor: 'central',
        workerLeaseGeneration: session.workerLeaseGeneration,
        payload: {
          reason: 'worker_lost',
          workerState: worker.lifecycleState
        }
      });
      const nextSession: SessionRecord = {
        ...session,
        status: 'failed',
        lifecycleReason: 'worker_lost',
        eventCursor: sequence,
        updatedAt: this.clock.now()
      };
      await this.storage.writeSession(nextSession);
    }
  }

  private hasActiveLease(session: SessionRecord, workerId: string): boolean {
    return session.currentWorkerId === workerId && (session.status === 'starting' || session.status === 'running');
  }

  private async requireWorker(workerId: string): Promise<WorkerRecord> {
    const worker = await this.storage.readWorker(workerId);
    if (!worker) {
      throw new Error(`worker ${workerId} does not exist`);
    }
    return worker;
  }

  private assertCurrentActiveWorker(worker: WorkerRecord, generation: number): void {
    if (!this.isCurrentActiveWorker(worker, generation)) {
      throw new Error(`worker ${worker.workerId} is not an active generation ${generation}`);
    }
  }

  private isCurrentActiveWorker(worker: WorkerRecord, generation: number): boolean {
    return worker.lifecycleState === 'active' && worker.generation === generation;
  }

  private normalizeActiveConditions(conditions: WorkerCondition[]): WorkerCondition[] {
    if (conditions.includes('draining')) {
      return ['draining'];
    }
    if (conditions.includes('busy')) {
      return ['busy'];
    }
    return ['ready'];
  }

  private async appendWorkerEvent<TPayload>(worker: WorkerRecord, type: RuntimeEvent['type'], payload: TPayload): Promise<RuntimeEvent<TPayload>> {
    const event: RuntimeEvent<TPayload> = {
      eventId: crypto.randomUUID(),
      workerId: worker.workerId,
      sequence: worker.generation,
      type,
      timestamp: this.clock.now(),
      actor: 'central',
      payload
    };
    await this.storage.appendEvent(event);
    return event;
  }

  private async appendHeartbeatRejected(worker: WorkerRecord, generation: number, reason: string): Promise<void> {
    await this.appendWorkerEvent(worker, 'worker.heartbeat.rejected', { generation, reason });
  }

  private expiresAt(timestamp: string): string {
    return new Date(Date.parse(timestamp) + this.keepaliveTtlMs).toISOString();
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
      && candidate.conditions.every((condition) => condition === 'ready' || condition === 'busy' || condition === 'draining' || condition === 'disconnected');
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

  private isStringRecord(value: unknown): value is Record<string, string> {
    return typeof value === 'object'
      && value !== null
      && Object.values(value).every((entry) => typeof entry === 'string');
  }
}