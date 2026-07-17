import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentSpec, Delegate, WorkerPoolRecord } from '../../shared';

/**
 * A WorkerPool config document declares the pool shape a tenant can scale. The runtime tenant binding
 * (`tenantId`) and deployment wiring (`centralUrlForWorkers`) are injected at load time, so they stay out
 * of the user-authored config file. `centralUrlForWorkers` here is the global default; a host-pool-controller
 * can override it for the workers it places (see `HostPoolControllerConfig.centralUrlForWorkers`).
 */
export type WorkerPoolConfig = Omit<WorkerPoolRecord, 'tenantId' | 'centralUrlForWorkers'>;

export interface WorkerPoolBinding {
  tenantId: string;
  centralUrlForWorkers: string;
}

/**
 * A host-pool-controller config document declares which host pool adapter provisions workers for a given
 * `hostPoolControllerClass` (= `id`). `adapterKind` matches a host pool adapter's self-declared classId in
 * code, so the lookup stays generic. Remaining fields are adapter-specific inputs (for example `imageName` +
 * `workerType` for the Docker adapter, or `projectEndpoint` + `agentName` + `workerType` for the Foundry
 * adapter); each adapter reads and validates its own fields, and central never branches on a specific adapterKind.
 * The optional `centralUrlForWorkers` overrides, for the workers this controller places, the global default URL
 * they use to reach central: a Foundry cloud sandbox needs a publicly reachable URL, while a local Docker worker
 * keeps the default (`host.docker.internal:<port>`).
 */
export interface HostPoolControllerConfig {
  id: string;
  adapterKind: string;
  centralUrlForWorkers?: string;
  [key: string]: unknown;
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

  loadDelegates(): Delegate[] {
    return this.readJsonDir<Delegate>('delegates');
  }

  loadWorkerPools(binding: WorkerPoolBinding): WorkerPoolRecord[] {
    const controllerCentralUrls = this.hostPoolControllerCentralUrls();
    return this.readJsonDir<WorkerPoolConfig>('worker-pools').map((pool) => ({
      ...pool,
      tenantId: binding.tenantId,
      // The URL a worker uses to reach central depends on where its host-pool controller places the worker
      // (a local Docker container reaches the host at host.docker.internal; a Foundry cloud sandbox needs a
      // publicly reachable URL). A controller may declare its own `centralUrlForWorkers`; pools fall back to
      // the global default binding when their controller does not.
      centralUrlForWorkers: controllerCentralUrls[pool.hostPoolControllerClass] ?? binding.centralUrlForWorkers
    }));
  }

  loadHostPoolControllers(): HostPoolControllerConfig[] {
    return this.readJsonDir<HostPoolControllerConfig>('host-pool-controllers');
  }

  private hostPoolControllerCentralUrls(): Record<string, string> {
    const overrides: Record<string, string> = {};
    for (const controller of this.loadHostPoolControllers()) {
      const url = controller.centralUrlForWorkers;
      if (typeof url === 'string' && url.length > 0) {
        overrides[controller.id] = url;
      }
    }
    return overrides;
  }

  private readJsonDir<T>(subdir: string): T[] {
    const directory = join(this.dir, subdir);
    return readdirSync(directory)
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .map((entry) => JSON.parse(readFileSync(join(directory, entry), 'utf8')) as T);
  }

  private readJsonDocument<T>(reference: string): T {
    const path = resolve(this.dir, reference);
    const pathFromRoot = relative(this.dir, path);
    if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
      throw new Error(`config reference must stay within config root: ${reference}`);
    }
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  }
}

export function defaultConfigDir(): string {
  return process.env.CONFIG_DIR ?? 'config';
}
