import type { SidecarBootstrap, SidecarHostAdapter, StartSidecarWorker } from './contracts';

/**
 * Default host adapter for self-hosted deployments (Docker container, local process): the host injects
 * bootstrap facts as process env at start, so this adapter reads them once and starts the worker directly.
 * There is no request-driven lifecycle to keep alive; the container runs until the host stops it.
 */
export class EnvSidecarHostAdapter implements SidecarHostAdapter {
  static readonly classId = 'env';

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async run(startWorker: StartSidecarWorker): Promise<void> {
    await startWorker(this.readBootstrap());
  }

  private readBootstrap(): SidecarBootstrap {
    const centralUrl = this.env.CENTRAL_URL;
    if (!centralUrl) {
      throw new Error('CENTRAL_URL is required to start sidecar');
    }
    const workerTypeId = this.env.WORKER_TYPE;
    if (!workerTypeId) {
      throw new Error('WORKER_TYPE is required to start sidecar');
    }
    const labelsJson = this.env.SIDECAR_LABELS_JSON;
    if (!labelsJson) {
      throw new Error('SIDECAR_LABELS_JSON is required to start sidecar');
    }
    const capacity = Number(this.env.SIDECAR_CAPACITY);
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('SIDECAR_CAPACITY must be a positive integer');
    }
    return {
      centralUrl,
      tenantId: this.env.TENANT_ID ?? 'poc',
      workerTypeId,
      hostPoolInstanceId: this.env.HOST_POOL_INSTANCE_ID,
      labels: JSON.parse(labelsJson) as Record<string, string>,
      capacity,
      description: this.readDescription()
    };
  }

  private readDescription(): Record<string, string> | undefined {
    const workerPoolId = this.env.WORKER_POOL_ID;
    if (!workerPoolId) {
      return undefined;
    }
    return {
      workerPoolId
    };
  }
}
