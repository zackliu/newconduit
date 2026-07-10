import type { AgentSpec, Clock, HostPoolInstanceRecord, RuntimeStorage, SessionRecord, SessionStatus, WorkerPoolRecord, WorkerRecord } from '../../../shared';
import { WorkerManager } from './worker-manager';

export interface HostPoolScaleOutInput {
  pool: WorkerPoolRecord;
  instance: HostPoolInstanceRecord;
}

export interface HostPoolScaleOutResult {
  containerId?: string;
}

export interface HostPoolScaleInInput {
  pool: WorkerPoolRecord;
  instance: HostPoolInstanceRecord;
  // Whether the host may release the instance's durable workspace. `retain`: the bound session is still alive
  // (e.g. paused) and will resume onto a fresh instance, so a session-keyed durable store (Foundry sandbox) must
  // survive. `release` (default): the session has ended or the instance is fungible, so the durable store may be
  // deleted. Compute is always released; hosts without session-keyed durability (Docker) ignore this.
  durableAction?: 'retain' | 'release';
}

export interface HostPoolAdapter {
  scaleOut(input: HostPoolScaleOutInput): Promise<HostPoolScaleOutResult>;
  scaleIn(input: HostPoolScaleInInput): Promise<void>;
}

export interface WorkerPoolManagerStatus {
  workerPools: WorkerPoolRecord[];
  hostPoolInstances: HostPoolInstanceRecord[];
  workers: WorkerRecord[];
  agentSpecs: AgentSpec[];
}

export class WorkerPoolManager {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    private readonly workerManager: WorkerManager,
    private readonly workerPools: WorkerPoolRecord[],
    private readonly hostPoolAdapters: Record<string, HostPoolAdapter>
  ) {}

  async reconcile(): Promise<void> {
    if (this.workerPools.length === 0) {
      return;
    }
    await this.correlateRegisteredWorkers();
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
      createdAt: now,
      updatedAt: now,
      ...(pin.boundSessionId ? { boundSessionId: pin.boundSessionId } : {}),
      ...(pin.workspaceRef ? { workspaceRef: pin.workspaceRef } : {})
    };
    await this.storage.writeHostPoolInstance(instance);
    try {
      const result = await adapter.scaleOut({ pool, instance });
      await this.storage.writeHostPoolInstance({
        ...instance,
        containerId: result.containerId,
        updatedAt: this.clock.now()
      });
    } catch (error) {
      await this.storage.writeHostPoolInstance({
        ...instance,
        state: 'failed',
        failureReason: error instanceof Error ? error.message : String(error),
        updatedAt: this.clock.now()
      });
    }
  }

  private async scaleInIdleWorkers(): Promise<void> {
    const workers = await this.storage.readWorkers();
    const instances = await this.storage.readHostPoolInstances();
    for (const pool of this.workerPools) {
      const adapter = this.requireHostPoolAdapter(pool);
      for (const instance of instances.filter((candidate) => candidate.poolId === pool.poolId && candidate.state === 'ready' && candidate.workerId)) {
        const worker = workers.find((candidate) => candidate.workerId === instance.workerId);
        if (!worker || !this.isScaleInCandidate(worker)) {
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
        const stopping: HostPoolInstanceRecord = { ...instance, state: 'stopping', updatedAt: now };
        await this.storage.writeHostPoolInstance(stopping);
        await this.workerManager.close({ workerId: worker.workerId });
        await adapter.scaleIn({ pool, instance: stopping, durableAction: await this.resolveDurableAction(stopping) });
        await this.storage.writeHostPoolInstance({
          ...stopping,
          state: 'stopped',
          idleSince,
          stoppedAt: this.clock.now(),
          updatedAt: this.clock.now()
        });
      }
    }
  }

  private async correlateRegisteredWorkers(): Promise<void> {
    const workers = await this.storage.readWorkers();
    const instances = await this.storage.readHostPoolInstances();
    for (const instance of instances.filter((candidate) => candidate.state === 'pending')) {
      const worker = workers.find((candidate) => candidate.description?.workerPoolInstanceId === instance.instanceId);
      if (!worker) {
        continue;
      }
      await this.stampWorkerPlacement(worker.workerId, instance);
      await this.storage.writeHostPoolInstance({
        ...instance,
        workerId: worker.workerId,
        state: worker.lifecycleState === 'active' && worker.conditions.includes('ready') ? 'ready' : 'pending',
        updatedAt: this.clock.now()
      });
    }
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
    return instance.state === 'pending' || (instance.state === 'ready' && !instance.workerId);
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