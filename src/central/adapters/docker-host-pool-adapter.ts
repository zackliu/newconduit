import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HostPoolAdapter, HostPoolScaleInInput, HostPoolScaleOutInput, HostPoolScaleOutResult } from '../managers';

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
 * Provisions Docker sidecar workers by running a pre-built image. Building the image is a build/deploy-time
 * concern (see `pnpm build:sidecar-image`), not part of scale-out: the adapter only `docker run`s `imageName`
 * and lets `docker run` fail loudly if the image is missing.
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

  async scaleOut(input: HostPoolScaleOutInput): Promise<HostPoolScaleOutResult> {
    const hostRuntimeRoot = join(this.sidecarWorkRoot, input.instance.instanceId);
    await mkdir(hostRuntimeRoot, { recursive: true });
    await mkdir(this.snapshotRoot, { recursive: true });
    const containerName = this.toContainerName(input.pool.poolId, input.instance.instanceId);
    const { stdout } = await execFileAsync('docker', [
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
      '-e', `WORKER_POOL_INSTANCE_ID=${input.instance.instanceId}`,
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
    return { containerId: stdout.trim() };
  }

  async scaleIn(input: HostPoolScaleInInput): Promise<void> {
    const container = input.instance.containerId || this.toContainerName(input.pool.poolId, input.instance.instanceId);
    await execFileAsync('docker', ['stop', container]);
  }

  private forwardEnv(...names: string[]): string[] {
    return names.flatMap((name) => {
      const value = this.env[name];
      return value ? ['-e', `${name}=${value}`] : [];
    });
  }

  private toContainerName(poolId: string, instanceId: string): string {
    return `ars-${poolId}-${instanceId}`.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 120);
  }
}