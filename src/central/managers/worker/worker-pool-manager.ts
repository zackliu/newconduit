import type { AgentSpec, Clock, HostPoolInstanceRecord, RuntimeStorage, SessionRecord, WorkerPoolRecord, WorkerRecord } from '../../../shared';
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
      if (queuedSessions.length === 0 || this.hasMatchingReadyWorker(workers, pool) || this.hasPendingInstance(instances, pool)) {
        continue;
      }
      const adapter = this.requireHostPoolAdapter(pool);
      const now = this.clock.now();
      for (let index = 0; index < pool.scalePolicy.scaleOutMaxPendingPerTick; index += 1) {
        const instance: HostPoolInstanceRecord = {
          instanceId: crypto.randomUUID(),
          tenantId: pool.tenantId,
          poolId: pool.poolId,
          hostPoolControllerClass: pool.hostPoolControllerClass,
          labels: pool.template.labels,
          capacity: pool.template.capacity,
          state: 'pending',
          createdAt: now,
          updatedAt: now
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
        await adapter.scaleIn({ pool, instance: stopping });
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
      await this.storage.writeHostPoolInstance({
        ...instance,
        workerId: worker.workerId,
        state: worker.lifecycleState === 'active' && worker.conditions.includes('ready') ? 'ready' : 'pending',
        updatedAt: this.clock.now()
      });
    }
  }

  private isQueuedForPool(session: SessionRecord, pool: WorkerPoolRecord): boolean {
    return session.tenantId === pool.tenantId
      && session.status === 'queued'
      && Date.parse(this.clock.now()) - Date.parse(session.lastEventUpdatedAt) < session.resolvedAgentSpec.idlePauseTimeoutMs
      && Object.entries(session.resolvedAgentSpec.workerSelector.matchLabels).every(([key, value]) => pool.template.labels[key] === value);
  }

  private hasMatchingReadyWorker(workers: WorkerRecord[], pool: WorkerPoolRecord): boolean {
    const now = Date.parse(this.clock.now());
    return workers.some((worker) => worker.tenantId === pool.tenantId
      && worker.lifecycleState === 'active'
      && Date.parse(worker.expiresAt) > now
      && worker.allocatable > 0
      && worker.conditions.includes('ready')
      && Object.entries(pool.template.labels).every(([key, value]) => worker.labels[key] === value));
  }

  private hasPendingInstance(instances: HostPoolInstanceRecord[], pool: WorkerPoolRecord): boolean {
    return instances.some((instance) => instance.poolId === pool.poolId && (instance.state === 'pending' || instance.state === 'ready' && !instance.workerId));
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