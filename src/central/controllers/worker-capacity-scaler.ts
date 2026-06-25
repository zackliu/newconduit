export interface WorkerHostingAdapter {
  startSidecarContainer(): Promise<{ containerId: string }>;
}

/**
 * Represents the capacity gap path: when queued sessions have no matching worker, this asks the hosting layer to create more sidecar capacity.
 */
export class WorkerCapacityScaler {
  constructor(private readonly hostingAdapter: WorkerHostingAdapter) {}

  async ensureOneWorker(): Promise<{ containerId: string }> {
    return this.hostingAdapter.startSidecarContainer();
  }
}