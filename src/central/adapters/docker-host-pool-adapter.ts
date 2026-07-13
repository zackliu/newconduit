import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HostPoolAdapter, HostPoolEnsureRunningInput, HostPoolEnsureRunningResult, HostPoolEnsureStoppedInput } from '../managers';

const execFileAsync = promisify(execFile);

export interface DockerHostPoolAdapterOptions {
  imageName?: string;
  azureConfigDir?: string;
  sidecarWorkRoot?: string;
  snapshotRoot?: string;
  workerType?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Converges a Docker host-pool instance to running or stopped. The deterministic container name makes
 * `ensureRunning` restart-safe: an existing running container is adopted, a stopped container is restarted,
 * and only a missing container is created from the pre-built image.
 */
export class DockerHostPoolAdapter implements HostPoolAdapter {
  static readonly classId = 'docker';
  private readonly imageName: string;
  private readonly azureConfigDir: string;
  private readonly sidecarWorkRoot: string;
  private readonly snapshotRoot: string;
  private readonly workerType: string | undefined;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: DockerHostPoolAdapterOptions = {}) {
    this.imageName = options.imageName ?? 'agent-runtime-sidecar-poc:latest';
    this.azureConfigDir = resolve(options.azureConfigDir ?? join(homedir(), '.azure'));
    this.sidecarWorkRoot = resolve(options.sidecarWorkRoot ?? '.runtime-poc/docker-sidecars');
    this.snapshotRoot = resolve(options.snapshotRoot ?? '.runtime-poc/snapshots');
    this.workerType = options.workerType;
    this.env = options.env ?? process.env;
  }

  async ensureRunning(input: HostPoolEnsureRunningInput): Promise<HostPoolEnsureRunningResult> {
    const containerName = this.toContainerName(input.pool.poolId, input.instance.instanceId);
    if (input.instance.hostHandle && input.instance.hostHandle !== containerName) {
      throw new Error(`docker host handle ${input.instance.hostHandle} does not match instance ${input.instance.instanceId}`);
    }
    const existing = await this.inspectContainer(containerName);
    if (existing && (existing.poolId !== input.pool.poolId || existing.instanceId !== input.instance.instanceId)) {
      throw new Error(`docker container ${containerName} is not owned by host pool instance ${input.instance.instanceId}`);
    }
    if (existing?.running) {
      return { hostHandle: containerName };
    }
    if (existing) {
      await execFileAsync('docker', ['start', containerName]);
      return { hostHandle: containerName };
    }
    const hostRuntimeRoot = join(this.sidecarWorkRoot, input.instance.instanceId);
    await mkdir(hostRuntimeRoot, { recursive: true });
    await mkdir(this.snapshotRoot, { recursive: true });
    await execFileAsync('docker', [
      'run',
      '-d',
      '--rm',
      '--name', containerName,
      '--label', `agent-runtime-sidecar.pool=${input.pool.poolId}`,
      '--label', `agent-runtime-sidecar.instance=${input.instance.instanceId}`,
      '-e', `CENTRAL_URL=${input.pool.centralUrlForWorkers}`,
      '-e', `TENANT_ID=${input.pool.tenantId}`,
      '-e', `SIDECAR_LABELS_JSON=${JSON.stringify(input.pool.template.labels)}`,
      '-e', `SIDECAR_CAPACITY=${input.pool.template.capacity}`,
      '-e', `WORKER_POOL_ID=${input.pool.poolId}`,
      '-e', `HOST_POOL_INSTANCE_ID=${input.instance.instanceId}`,
      '-e', 'AZURE_CONFIG_DIR=/home/sidecar/.azure',
      '-e', 'SIDECAR_WORK_ROOT=/runtime/sidecar',
      '-e', 'SIDECAR_SNAPSHOT_ROOT=/snapshots',
      ...(this.workerType ? ['-e', `WORKER_TYPE=${this.workerType}`] : []),
      ...this.forwardEnv('WEBPUBSUB_ENDPOINT', 'WEBPUBSUB_HUB', 'COPILOT_MODEL', 'COPILOT_PROVIDER_TYPE', 'COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDER_TOKEN_SCOPE', 'COPILOT_PROVIDER_WIRE_API', 'COPILOT_PROVIDER_AZURE_API_VERSION', 'COPILOT_CLI_PATH', 'COPILOT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'),
      '-v', `${this.azureConfigDir}:/home/sidecar/.azure`,
      '-v', `${hostRuntimeRoot}:/runtime`,
      '-v', `${this.snapshotRoot}:/snapshots`,
      this.imageName
    ]);
    return { hostHandle: containerName };
  }

  async ensureStopped(input: HostPoolEnsureStoppedInput): Promise<void> {
    const containerName = this.toContainerName(input.pool.poolId, input.instance.instanceId);
    if (input.instance.hostHandle && input.instance.hostHandle !== containerName) {
      throw new Error(`docker host handle ${input.instance.hostHandle} does not match instance ${input.instance.instanceId}`);
    }
    const existing = await this.inspectContainer(containerName);
    if (!existing) {
      return;
    }
    if (existing.poolId !== input.pool.poolId || existing.instanceId !== input.instance.instanceId) {
      throw new Error(`docker container ${containerName} is not owned by host pool instance ${input.instance.instanceId}`);
    }
    if (!existing.running) {
      return;
    }
    await execFileAsync('docker', ['stop', containerName]);
  }

  async releaseControl(): Promise<void> {
    return;
  }

  private async inspectContainer(container: string): Promise<{ running: boolean; poolId: string; instanceId: string } | undefined> {
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect',
        '--format',
        '{{.State.Running}} {{index .Config.Labels "agent-runtime-sidecar.pool"}} {{index .Config.Labels "agent-runtime-sidecar.instance"}}',
        container
      ]);
      const [running, poolId, instanceId] = stdout.trim().split(/\s+/);
      if ((running !== 'true' && running !== 'false') || !poolId || !instanceId) {
        throw new Error(`docker inspect returned invalid state for ${container}`);
      }
      return { running: running === 'true', poolId, instanceId };
    } catch (error) {
      if (this.isMissingContainer(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private isMissingContainer(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('stderr' in error)) {
      return false;
    }
    return /no such (object|container)/i.test(String(error.stderr));
  }

  private forwardEnv(...names: string[]): string[] {
    return names.flatMap((name) => {
      const value = this.env[name];
      return value ? ['-e', `${name}=${value}`] : [];
    });
  }

  private toContainerName(poolId: string, instanceId: string): string {
    const suffix = `-${instanceId.replace(/[^a-zA-Z0-9_.-]/g, '-')}`;
    const prefix = `ars-${poolId}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    return `${prefix.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`;
  }
}