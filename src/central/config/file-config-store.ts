import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentSpec, WorkerPoolRecord } from '../../shared';

/**
 * A WorkerPool config document declares the pool shape a tenant can scale. The runtime tenant binding
 * (`tenantId`) and deployment wiring (`centralUrlForWorkers`) are injected at load time, so they stay out
 * of the user-authored config file.
 */
export type WorkerPoolConfig = Omit<WorkerPoolRecord, 'tenantId' | 'centralUrlForWorkers'>;

export interface WorkerPoolBinding {
  tenantId: string;
  centralUrlForWorkers: string;
}

/**
 * A host-pool-controller config document declares which host pool adapter kind provisions a worker for a given
 * `hostPoolControllerClass`, which pre-built image to run, and which worker type it hosts. `adapterKind` matches a
 * host pool adapter's self-declared classId in code, so the lookup stays generic. Building the image is out of
 * band (not a runtime concern), so no build inputs live here.
 */
export interface HostPoolControllerConfig {
  id: string;
  adapterKind: string;
  imageName: string;
  workerType: string;
}

/**
 * Reads user-configurable desired-state documents (AgentSpec, WorkerPool) from a config directory instead
 * of hardcoding them in source. The config directory ships with the demo but stays out of `src/`, and is
 * the default config source at startup. This is the config-store sibling of the runtime-state file store.
 */
export class FileConfigStore {
  private readonly dir: string;

  constructor(dir: string = defaultConfigDir()) {
    this.dir = resolve(dir);
  }

  loadAgentSpecs(): AgentSpec[] {
    return this.readJsonDir<AgentSpec>('agent-specs');
  }

  loadWorkerPools(binding: WorkerPoolBinding): WorkerPoolRecord[] {
    return this.readJsonDir<WorkerPoolConfig>('worker-pools').map((pool) => ({
      ...pool,
      tenantId: binding.tenantId,
      centralUrlForWorkers: binding.centralUrlForWorkers
    }));
  }

  loadHostPoolControllers(): HostPoolControllerConfig[] {
    return this.readJsonDir<HostPoolControllerConfig>('host-pool-controllers');
  }

  private readJsonDir<T>(subdir: string): T[] {
    const directory = join(this.dir, subdir);
    return readdirSync(directory)
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .map((entry) => JSON.parse(readFileSync(join(directory, entry), 'utf8')) as T);
  }
}

export function defaultConfigDir(): string {
  return process.env.CONFIG_DIR ?? 'config';
}
