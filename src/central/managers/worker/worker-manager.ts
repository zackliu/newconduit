import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, type Clock, type RuntimeEvent, type RuntimeEventTransport, type RuntimeStorage, type SessionRecord, type TurnFailedPayload, type WorkerCondition, type WorkerHeartbeatPayload, type WorkerIdentityPayload, type WorkerRecord, type WorkerRegisterPayload } from '../../../shared';

const DEFAULT_KEEPALIVE_TTL_MS = 30_000;

/**
 * Maintains the tenant's view of worker capacity over time, including the failure effects when leased compute disappears.
 */
export class WorkerManager {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    private readonly keepaliveTtlMs = DEFAULT_KEEPALIVE_TTL_MS,
    private readonly eventTransport?: RuntimeEventTransport
  ) {}

  async register(input: { tenantId: string } & WorkerRegisterPayload): Promise<WorkerRecord> {
    const now = this.clock.now();
    const worker: WorkerRecord = {
      workerId: crypto.randomUUID(),
      tenantId: input.tenantId,
      capacityScope: input.tenantId,
      sidecarClass: input.sidecarClass,
      labels: input.labels,
      description: input.description,
      capacity: input.capacity,
      allocatable: 0,
      conditions: ['disconnected'],
      lifecycleState: 'registered',
      heartbeatAt: now,
      expiresAt: this.expiresAt(now),
      currentSessionCount: 0,
      updatedAt: now
    };
    await this.storage.writeWorker(worker);
    await this.appendWorkerEvent(worker, 'worker.registered', {
      sidecarClass: worker.sidecarClass,
      labels: worker.labels,
      description: worker.description,
      capacity: worker.capacity,
      allocatable: input.allocatable
    });
    return worker;
  }

  async heartbeat(input: WorkerHeartbeatPayload): Promise<WorkerRecord | undefined> {
    const worker = await this.storage.readWorker(input.workerId);
    if (!worker) {
      await this.appendUnknownHeartbeatRejected(input.workerId);
      return undefined;
    }
    if (!this.isHeartbeatAcceptable(worker)) {
      await this.appendHeartbeatRejected(worker, 'terminal-worker');
      return worker;
    }

    const now = this.clock.now();
    const next: WorkerRecord = {
      ...worker,
      capacity: input.capacity,
      allocatable: input.allocatable,
      conditions: this.normalizeActiveConditions(input.conditions),
      lifecycleState: 'active',
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
    this.assertActiveWorker(worker);
    const next: WorkerRecord = {
      ...worker,
      allocatable: 0,
      conditions: ['draining'],
      updatedAt: this.clock.now()
    };
    await this.storage.writeWorker(next);
    await this.appendWorkerEvent(next, 'worker.draining', {});
    return next;
  }

  async close(input: WorkerIdentityPayload): Promise<WorkerRecord> {
    const worker = await this.requireWorker(input.workerId);
    this.assertActiveWorker(worker);
    return this.terminate(worker, 'closed', 'worker_closed', 'worker.closed');
  }

  async expireWorkers(): Promise<WorkerRecord[]> {
    const now = Date.parse(this.clock.now());
    const workers = await this.storage.readWorkers();
    const expiredWorkers = workers.filter((worker) => (worker.lifecycleState === 'active' || worker.lifecycleState === 'registered') && Date.parse(worker.expiresAt) <= now);
    const terminatedWorkers: WorkerRecord[] = [];
    for (const worker of expiredWorkers) {
      terminatedWorkers.push(await this.terminate(worker, 'expired', 'worker_keepalive_expired', 'worker.expired'));
    }
    return terminatedWorkers;
  }

  async releaseSessionLease(workerId: string): Promise<WorkerRecord> {
    const worker = await this.requireWorker(workerId);
    if (worker.lifecycleState !== 'active') {
      return worker;
    }
    const currentSessionCount = Math.max(0, worker.currentSessionCount - 1);
    const allocatable = Math.min(worker.capacity, worker.allocatable + 1);
    const next: WorkerRecord = {
      ...worker,
      currentSessionCount,
      allocatable,
      conditions: allocatable > 0 ? ['ready'] : worker.conditions,
      updatedAt: this.clock.now()
    };
    await this.storage.writeWorker(next);
    return next;
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
      let sequence = session.eventCursor;
      const inFlightTurnSeq = await this.findInFlightTurnSeq(session);
      if (inFlightTurnSeq !== undefined) {
        sequence += 1;
        await this.appendSessionEvent<TurnFailedPayload>(session.sessionId, {
          eventId: crypto.randomUUID(),
          sessionId: session.sessionId,
          workerId: worker.workerId,
          sequence,
          type: 'turn.failed',
          timestamp: this.clock.now(),
          actor: 'central',
          turnSeq: inFlightTurnSeq,
          sessionLeaseId: session.sessionLeaseId,
          payload: {
            error: {
              message: 'worker was lost before the turn completed',
              code: 'worker_lost',
              details: {
                workerState: worker.lifecycleState
              }
            }
          }
        });
      }
      sequence += 1;
      await this.appendSessionEvent(session.sessionId, {
        eventId: crypto.randomUUID(),
        sessionId: session.sessionId,
        workerId: worker.workerId,
        sequence,
        type: 'session.lease.lost',
        timestamp: this.clock.now(),
        actor: 'central',
        sessionLeaseId: session.sessionLeaseId,
        payload: {
          reason: 'worker_lost',
          workerState: worker.lifecycleState
        }
      });
      const nextSession: SessionRecord = {
        ...session,
        status: 'failed',
        currentWorkerId: undefined,
        sessionLeaseId: undefined,
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

  private async findInFlightTurnSeq(session: SessionRecord): Promise<number | undefined> {
    const candidateTurnSeq = session.nextTurnSeq - 1;
    if (candidateTurnSeq < 1) {
      return undefined;
    }
    const events = await this.storage.readEvents(session.sessionId, 0);
    const turnEvents = events.filter((event) => event.turnSeq === candidateTurnSeq);
    if (turnEvents.length === 0) {
      return undefined;
    }
    if (turnEvents.some((event) => event.type === 'turn.completed' || event.type === 'turn.failed')) {
      return undefined;
    }
    return candidateTurnSeq;
  }

  private async appendSessionEvent<TPayload>(sessionId: string, event: RuntimeEvent<TPayload>): Promise<void> {
    const appended = await this.storage.appendEvent(event);
    await this.eventTransport?.publish({ kind: 'session-events', sessionId }, appended);
    if (event.type === 'session.lease.lost') {
      await this.eventTransport?.publish({ kind: 'client-inbox' }, {
        ...appended,
        ackId: undefined,
        type: 'session.status.updated',
        payload: {
          sessionId,
          status: 'failed',
          reason: 'worker_lost'
        }
      });
    }
  }

  private async requireWorker(workerId: string): Promise<WorkerRecord> {
    const worker = await this.storage.readWorker(workerId);
    if (!worker) {
      throw new Error(`worker ${workerId} does not exist`);
    }
    return worker;
  }

  private assertActiveWorker(worker: WorkerRecord): void {
    if (worker.lifecycleState !== 'active') {
      throw new Error(`worker ${worker.workerId} is not active`);
    }
  }

  private isHeartbeatAcceptable(worker: WorkerRecord): boolean {
    return worker.lifecycleState === 'registered' || worker.lifecycleState === 'active';
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
      sequence: 0,
      type,
      timestamp: this.clock.now(),
      actor: 'central',
      payload
    };
    await this.storage.appendEvent(event);
    return event;
  }

  private async appendHeartbeatRejected(worker: WorkerRecord, reason: string): Promise<void> {
    await this.appendWorkerEvent(worker, 'worker.heartbeat.rejected', { reason });
  }

  private async appendUnknownHeartbeatRejected(workerId: string): Promise<void> {
    await this.storage.appendEvent({
      eventId: crypto.randomUUID(),
      workerId,
      sequence: 0,
      type: 'worker.heartbeat.rejected',
      timestamp: this.clock.now(),
      actor: 'central',
      payload: { reason: 'unknown-worker' }
    });
  }

  private expiresAt(timestamp: string): string {
    return new Date(Date.parse(timestamp) + this.keepaliveTtlMs).toISOString();
  }
}