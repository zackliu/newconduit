export interface WorkerHostingAdapter {
  startSidecarContainer(): Promise<{ containerId: string }>;
}

export class WorkerCapacityScaler {
  constructor(private readonly hostingAdapter: WorkerHostingAdapter) {}

  async ensureOneWorker(): Promise<{ containerId: string }> {
    return this.hostingAdapter.startSidecarContainer();
  }
}