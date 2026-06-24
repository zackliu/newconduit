import type { DockerHostingAdapter } from '../adapters';

export class WorkerCapacityScaler {
  constructor(private readonly hostingAdapter: DockerHostingAdapter) {}

  async ensureOneWorker(): Promise<{ containerId: string }> {
    return this.hostingAdapter.startSidecarContainer();
  }
}