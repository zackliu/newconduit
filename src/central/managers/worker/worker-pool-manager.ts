import type { AgentSpec, Clock, HostPoolInstanceRecord, RuntimeStorage, SessionRecord, SessionStatus, WorkerPoolRecord, WorkerRecord } from '../../../shared';
import { WorkerManager } from './worker-manager';

export interface HostPoolEnsureRunningInput {
  pool: WorkerPoolRecord;
  instance: HostPoolInstanceRecord;
}

export interface HostPoolEnsureRunningResult {
  hostHandle: string;
}

export interface HostPoolEnsureStoppedInput {
  pool: WorkerPoolRecord;
  instance: HostPoolInstanceRecord;
  // Whether the host may release the instance's durable workspace. `retain`: the bound session is still alive
  // (e.g. paused) and will resume onto a fresh instance, so a session-keyed durable store (Foundry sandbox) must
  // survive. `release` (default): the session has ended or the instance is fungible, so the durable store may be
  // deleted. Compute is always released; hosts without session-keyed durability (Docker) ignore this.
  durableAction?: 'retain' | 'release';
}

export interface HostPoolAdapter {
  ensureRunning(input: HostPoolEnsureRunningInput): Promise<HostPoolEnsureRunningResult>;
  ensureStopped(input: HostPoolEnsureStoppedInput): Promise<void>;
  /** Releases process-local control without changing any HostPoolInstance desired state. */
  releaseControl(): Promise<void>;
}

export interface WorkerPoolManagerStatus {
  workerPools: WorkerPoolRecord[];
  hostPoolInstances: HostPoolInstanceRecord[];
  workers: WorkerRecord[];
  agentSpecs: AgentSpec[];
}

export class WorkerPoolManager {
  private reconcileTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    private readonly workerManager: WorkerManager,
    private readonly workerPools: WorkerPoolRecord[],
    private readonly hostPoolAdapters: Record<string, HostPoolAdapter>,
    private readonly controllerEpoch: string = crypto.randomUUID()
  ) {}

  reconcile(): Promise<void> {
    const run = this.reconcileTail.then(() => this.reconcileOnce());
    this.reconcileTail = run.catch(() => undefined);
    return run;
  }

  private async reconcileOnce(): Promise<void> {
    if (this.workerPools.length === 0) {
      return;
    }
    await this.reconcileHostPoolInstances();
    await this.scaleOutForQueuedSessions();
    await this.scaleInIdleWorkers();
  }

  async describe(): Promise<WorkerPoolManagerStatus> {
    return {
      workerPools: this.workerPools,
      hostPoolInstances: await this.storage.readHostPoolInstances(),
      workers: await this.storage.readWorkers(),
      agentSpecs: []
    };
  }

  async releaseControl(): Promise<void> {
    await Promise.all([...new Set(Object.values(this.hostPoolAdapters))].map((adapter) => adapter.releaseControl()));
  }

  private async scaleOutForQueuedSessions(): Promise<void> {
    const sessions = await this.storage.readSessions();
    const workers = await this.storage.readWorkers();
    const instances = await this.storage.readHostPoolInstances();
    for (const pool of this.workerPools) {
      const queuedSessions = sessions.filter((session) => this.isQueuedForPool(session, pool));
      if (queuedSessions.length === 0) {
        continue;
      }
      // A no-reuse worker bound to another session is not assignable capacity for a different queued session, so
      // scale by unmet per-session demand (minus instances already coming) instead of a single pool-wide check.
      const unservedSessions = queuedSessions.filter((session) => !this.hasAssignableWorker(workers, pool, session));
      const budget = pool.scalePolicy.scaleOutMaxPendingPerTick - this.pendingInstanceCount(instances, pool);
      if (budget <= 0) {
        continue;
      }
      const adapter = this.requireHostPoolAdapter(pool);
      if (pool.reuse === false) {
        // No-reuse: each session needs its own worker, so pin one instance per still-unpinned unserved session.
        // The pin (boundSessionId + workspaceRef) lets a session-keyed durable host (Foundry sandbox) stay stable
        // across pause/resume, and lets correlate pre-bind the worker to exactly this session.
        const pinnedPendingSessions = new Set(instances
          .filter((instance) => instance.poolId === pool.poolId && instance.boundSessionId && this.isPendingInstance(instance))
          .map((instance) => instance.boundSessionId));
        const sessionsToPin = unservedSessions
          .filter((session) => !pinnedPendingSessions.has(session.sessionId))
          .slice(0, budget);
        for (const session of sessionsToPin) {
          await this.scaleOutInstance(pool, adapter, { boundSessionId: session.sessionId, workspaceRef: session.workspaceRef });
        }
        continue;
      }
      // Shared: capacity is fungible, so scale by the count of unmet sessions.
      const toScale = Math.min(unservedSessions.length, budget);
      for (let index = 0; index < toScale; index += 1) {
        await this.scaleOutInstance(pool, adapter, {});
      }
    }
  }

  private async scaleOutInstance(pool: WorkerPoolRecord, adapter: HostPoolAdapter, pin: { boundSessionId?: string; workspaceRef?: string }): Promise<void> {
    const now = this.clock.now();
    const instance: HostPoolInstanceRecord = {
      instanceId: crypto.randomUUID(),
      tenantId: pool.tenantId,
      poolId: pool.poolId,
      hostPoolControllerClass: pool.hostPoolControllerClass,
      labels: pool.template.labels,
      capacity: pool.template.capacity,
      state: 'pending',
      controllerEpoch: this.controllerEpoch,
      reportExpectedAfter: now,
      reportDeadline: this.reportDeadline(now, pool),
      createdAt: now,
      updatedAt: now,
      ...(pin.boundSessionId ? { boundSessionId: pin.boundSessionId } : {}),
      ...(pin.workspaceRef ? { workspaceRef: pin.workspaceRef } : {})
    };
    await this.storage.writeHostPoolInstance(instance);
    const running = await this.ensureInstanceRunning(pool, adapter, instance);
    if (running) {
      await this.reconcilePendingInstance(pool, adapter, running);
    }
  }

  private async reconcileHostPoolInstances(): Promise<void> {
    const allInstances = await this.storage.readHostPoolInstances();
    for (const pool of this.workerPools) {
      const adapter = this.requireHostPoolAdapter(pool);
      for (const stored of allInstances.filter((instance) => instance.poolId === pool.poolId && instance.state !== 'stopped' && instance.state !== 'failed')) {
        if (stored.state === 'stopping') {
          await this.completeStoppingInstance(pool, adapter, stored);
          continue;
        }

        let instance = stored;
        if (this.needsReportExpectation(instance)) {
          instance = await this.rearmReportExpectation(instance, pool);
        }

        if (instance.state === 'ready') {
          const worker = instance.currentWorkerId ? await this.storage.readWorker(instance.currentWorkerId) : undefined;
          if (this.isWorkerTerminal(worker)) {
            await this.stopInstance(pool, adapter, instance, worker, 'failed', 'current_worker_lost');
            continue;
          }
          if (instance.currentWorkerId && !worker) {
            // Workers are never deleted, only marked terminal, so a missing worker record for a ready instance is a
            // storage-invariant violation, not evidence the worker died. Never destroy a possibly-live host on absence.
            console.error(`host pool instance ${instance.instanceId} references missing worker ${instance.currentWorkerId}; not treating absence as worker loss`);
            continue;
          }
        }

        const running = await this.ensureInstanceRunning(pool, adapter, instance);
        if (running?.state === 'pending') {
          await this.reconcilePendingInstance(pool, adapter, running);
        }
      }
    }
  }

  private needsReportExpectation(instance: HostPoolInstanceRecord): boolean {
    return instance.controllerEpoch !== this.controllerEpoch
      || (instance.state === 'pending' && (!instance.reportExpectedAfter || !instance.reportDeadline));
  }

  private async rearmReportExpectation(instance: HostPoolInstanceRecord, pool: WorkerPoolRecord): Promise<HostPoolInstanceRecord> {
    const now = this.clock.now();
    const pending: HostPoolInstanceRecord = {
      ...instance,
      state: 'pending',
      currentWorkerId: undefined,
      controllerEpoch: this.controllerEpoch,
      reportExpectedAfter: now,
      reportDeadline: this.reportDeadline(now, pool),
      idleSince: undefined,
      failureReason: undefined,
      updatedAt: now
    };
    await this.storage.writeHostPoolInstance(pending);
    const workers = await this.storage.readWorkers();
    for (const worker of workers.filter((candidate) => candidate.hostPoolInstanceId === instance.instanceId
      && (candidate.lifecycleState === 'registered' || candidate.lifecycleState === 'active'))) {
      await this.workerManager.awaitFreshReport({ workerId: worker.workerId, deadline: pending.reportDeadline! });
    }
    return pending;
  }

  private async ensureInstanceRunning(pool: WorkerPoolRecord, adapter: HostPoolAdapter, instance: HostPoolInstanceRecord): Promise<HostPoolInstanceRecord | undefined> {
    try {
      const result = await adapter.ensureRunning({ pool, instance });
      if (instance.hostHandle && instance.hostHandle !== result.hostHandle) {
        await this.stopInstance(pool, adapter, instance, undefined, 'failed', 'host_handle_changed');
        return undefined;
      }
      if (instance.hostHandle === result.hostHandle) {
        return instance;
      }
      const next = { ...instance, hostHandle: result.hostHandle, updatedAt: this.clock.now() };
      await this.storage.writeHostPoolInstance(next);
      return next;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.stopInstance(pool, adapter, instance, undefined, 'failed', `host_ensure_running_failed: ${reason}`);
      return undefined;
    }
  }

  private async reconcilePendingInstance(pool: WorkerPoolRecord, adapter: HostPoolAdapter, instance: HostPoolInstanceRecord): Promise<void> {
    if (!instance.reportExpectedAfter || !instance.reportDeadline) {
      throw new Error(`pending host pool instance ${instance.instanceId} has no Worker report expectation`);
    }
    const workers = await this.storage.readWorkers();
    const candidates = workers.filter((worker) => this.isQualifyingWorkerReport(worker, instance, pool));
    if (candidates.length === 1) {
      const [worker] = candidates;
      await this.stampWorkerPlacement(worker.workerId, instance);
      await this.storage.writeHostPoolInstance({
        ...instance,
        state: 'ready',
        currentWorkerId: worker.workerId,
        reportExpectedAfter: undefined,
        reportDeadline: undefined,
        updatedAt: this.clock.now()
      });
      return;
    }
    if (candidates.length > 1) {
      await this.fenceInstanceWorkers(instance, 'multiple_worker_reports');
      await this.stopInstance(pool, adapter, instance, undefined, 'failed', 'multiple_worker_reports');
      return;
    }
    if (Date.parse(this.clock.now()) < Date.parse(instance.reportDeadline)) {
      return;
    }
    await this.fenceInstanceWorkers(instance, 'worker_report_timeout');
    await this.stopInstance(pool, adapter, instance, undefined, 'failed', 'worker_report_timeout');
  }

  private isQualifyingWorkerReport(worker: WorkerRecord, instance: HostPoolInstanceRecord, pool: WorkerPoolRecord): boolean {
    const now = Date.parse(this.clock.now());
    const expectedStorageClass = pool.template.labels.storage;
    return worker.tenantId === instance.tenantId
      && worker.hostPoolInstanceId === instance.instanceId
      && worker.lifecycleState === 'active'
      && !worker.conditions.includes('disconnected')
      && Date.parse(worker.heartbeatAt) >= Date.parse(instance.reportExpectedAfter!)
      && Date.parse(worker.heartbeatAt) <= Date.parse(instance.reportDeadline!)
      && Date.parse(worker.expiresAt) > now
      && worker.capacity === instance.capacity
      && (!expectedStorageClass || worker.storageClass === expectedStorageClass)
      && Object.entries(instance.labels).every(([key, value]) => worker.labels[key] === value);
  }

  private async fenceInstanceWorkers(instance: HostPoolInstanceRecord, reason: string): Promise<void> {
    const workers = await this.storage.readWorkers();
    for (const worker of workers.filter((candidate) => candidate.hostPoolInstanceId === instance.instanceId
      && (candidate.lifecycleState === 'registered' || candidate.lifecycleState === 'active'))) {
      await this.workerManager.expire({ workerId: worker.workerId, reason });
    }
  }

  private async scaleInIdleWorkers(): Promise<void> {
    const workers = await this.storage.readWorkers();
    const instances = await this.storage.readHostPoolInstances();
    for (const pool of this.workerPools) {
      const adapter = this.requireHostPoolAdapter(pool);
      for (const instance of instances.filter((candidate) => candidate.poolId === pool.poolId && candidate.state === 'ready' && candidate.currentWorkerId)) {
        const worker = workers.find((candidate) => candidate.workerId === instance.currentWorkerId);
        if (this.isWorkerTerminal(worker)) {
          await this.stopInstance(pool, adapter, instance, worker, 'failed', 'current_worker_lost');
          continue;
        }
        if (!worker) {
          // A missing worker record is a storage-invariant violation, never evidence of worker death: do not scale in.
          console.error(`host pool instance ${instance.instanceId} references missing worker ${instance.currentWorkerId}; not treating absence as worker loss`);
          continue;
        }
        if (!this.isScaleInCandidate(worker)) {
          await this.clearIdleSince(instance);
          continue;
        }
        const now = this.clock.now();
        const idleSince = instance.idleSince ?? now;
        if (!instance.idleSince) {
          await this.storage.writeHostPoolInstance({ ...instance, idleSince, updatedAt: now });
          continue;
        }
        if (Date.parse(now) - Date.parse(idleSince) < pool.scalePolicy.scaleInIdleMs) {
          continue;
        }
        const currentInstance = await this.storage.readHostPoolInstance(instance.instanceId);
        const currentWorker = await this.storage.readWorker(worker.workerId);
        if (currentInstance?.state !== 'ready'
          || currentInstance.currentWorkerId !== worker.workerId
          || !currentWorker
          || !this.isScaleInCandidate(currentWorker)) {
          if (currentInstance) {
            await this.clearIdleSince(currentInstance);
          }
          continue;
        }
        await this.stopInstance(pool, adapter, { ...currentInstance, idleSince }, currentWorker, 'stopped');
      }
    }
  }

  private async stopInstance(
    pool: WorkerPoolRecord,
    adapter: HostPoolAdapter,
    instance: HostPoolInstanceRecord,
    worker: WorkerRecord | undefined,
    outcome: 'stopped' | 'failed',
    failureReason?: string
  ): Promise<void> {
    const stopping: HostPoolInstanceRecord = {
      ...instance,
      state: 'stopping',
      failureReason: outcome === 'failed' ? failureReason ?? 'host_instance_failed' : undefined,
      updatedAt: this.clock.now()
    };
    await this.storage.writeHostPoolInstance(stopping);
    if (worker?.lifecycleState === 'active') {
      await this.workerManager.close({ workerId: worker.workerId });
    }
    await adapter.ensureStopped({ pool, instance: stopping, durableAction: await this.resolveDurableAction(stopping) });
    const stoppedAt = this.clock.now();
    await this.storage.writeHostPoolInstance({
      ...stopping,
      state: outcome,
      stoppedAt,
      updatedAt: stoppedAt
    });
  }

  private async completeStoppingInstance(pool: WorkerPoolRecord, adapter: HostPoolAdapter, instance: HostPoolInstanceRecord): Promise<void> {
    const worker = instance.currentWorkerId ? await this.storage.readWorker(instance.currentWorkerId) : undefined;
    await this.stopInstance(pool, adapter, instance, worker, instance.failureReason ? 'failed' : 'stopped', instance.failureReason);
  }

  /**
   * Resolves the owning pool's placement policy onto the worker so the (pool-unaware) WorkerSelector can honor it:
   * the pool's reuse flag, plus — for a session-pinned instance — the bound session, so only that session is ever
   * placed on this worker (and it lands in its own durable workspace). Re-reads the worker to avoid clobbering a
   * concurrent heartbeat; both are stable facts, stamped once.
   */
  private async stampWorkerPlacement(workerId: string, instance: HostPoolInstanceRecord): Promise<void> {
    const pool = this.workerPools.find((candidate) => candidate.poolId === instance.poolId);
    if (!pool) {
      return;
    }
    const reuse = pool.reuse !== false;
    const worker = await this.storage.readWorker(workerId);
    if (!worker) {
      return;
    }
    const boundSessionId = worker.boundSessionId ?? instance.boundSessionId;
    if (worker.reuse === reuse && worker.boundSessionId === boundSessionId) {
      return;
    }
    await this.storage.writeWorker({ ...worker, reuse, boundSessionId, updatedAt: this.clock.now() });
  }

  private isQueuedForPool(session: SessionRecord, pool: WorkerPoolRecord): boolean {
    return session.tenantId === pool.tenantId
      && session.status === 'queued'
      && Date.parse(this.clock.now()) - Date.parse(session.lastEventUpdatedAt) < session.resolvedAgentSpec.idlePauseTimeoutMs
      && Object.entries(session.resolvedAgentSpec.workerSelector.matchLabels).every(([key, value]) => pool.template.labels[key] === value);
  }

  private hasAssignableWorker(workers: WorkerRecord[], pool: WorkerPoolRecord, session: SessionRecord): boolean {
    const now = Date.parse(this.clock.now());
    return workers.some((worker) => worker.tenantId === pool.tenantId
      && worker.lifecycleState === 'active'
      && Date.parse(worker.expiresAt) > now
      && worker.allocatable > 0
      && worker.conditions.includes('ready')
      && Object.entries(session.resolvedAgentSpec.workerSelector.matchLabels).every(([key, value]) => worker.labels[key] === value)
      && (pool.reuse !== false || !worker.boundSessionId || worker.boundSessionId === session.sessionId));
  }

  private pendingInstanceCount(instances: HostPoolInstanceRecord[], pool: WorkerPoolRecord): number {
    return instances.filter((instance) => instance.poolId === pool.poolId && this.isPendingInstance(instance)).length;
  }

  private isPendingInstance(instance: HostPoolInstanceRecord): boolean {
    return instance.state === 'pending' || (instance.state === 'ready' && !instance.currentWorkerId);
  }

  private reportDeadline(expectedAfter: string, pool: WorkerPoolRecord): string {
    return new Date(Date.parse(expectedAfter) + pool.scalePolicy.workerReportTimeoutMs).toISOString();
  }

  /**
   * A session-pinned instance keeps its durable workspace only while its session is still alive: `retain` when the
   * bound session exists and is non-terminal (e.g. paused, resuming) so a resume finds the sandbox intact; `release`
   * when the session has ended or the instance is fungible (no binding), so the host may delete the durable store.
   */
  private async resolveDurableAction(instance: HostPoolInstanceRecord): Promise<'retain' | 'release'> {
    if (!instance.boundSessionId) {
      return 'release';
    }
    const session = await this.storage.readSession(instance.boundSessionId);
    if (!session || this.isTerminalSession(session.status)) {
      return 'release';
    }
    return 'retain';
  }

  private isTerminalSession(status: SessionStatus): boolean {
    return status === 'completed' || status === 'cancelled' || status === 'failed';
  }

  private isScaleInCandidate(worker: WorkerRecord): boolean {
    return worker.lifecycleState === 'active'
      && worker.conditions.includes('ready')
      && worker.currentSessionCount === 0
      && worker.allocatable === worker.capacity;
  }

  // Only a durable terminal worker fact justifies destroying its host. Absence is never such a fact: workers are never
  // deleted, only transitioned to closed/expired by the worker lifecycle, so a missing record means storage is
  // inconsistent, not that the compute died.
  private isWorkerTerminal(worker: WorkerRecord | undefined): boolean {
    return worker !== undefined && (worker.lifecycleState === 'closed' || worker.lifecycleState === 'expired');
  }

  private async clearIdleSince(instance: HostPoolInstanceRecord): Promise<void> {
    if (!instance.idleSince) {
      return;
    }
    await this.storage.writeHostPoolInstance({ ...instance, idleSince: undefined, updatedAt: this.clock.now() });
  }

  private requireHostPoolAdapter(pool: WorkerPoolRecord): HostPoolAdapter {
    const adapter = this.hostPoolAdapters[pool.hostPoolControllerClass];
    if (!adapter) {
      throw new Error(`hostPoolAdapter ${pool.hostPoolControllerClass} is not configured`);
    }
    return adapter;
  }
}