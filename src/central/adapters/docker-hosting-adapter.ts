import type { WorkerHostingAdapter } from '../controllers/worker-capacity-scaler';

export class DockerHostingAdapter implements WorkerHostingAdapter {
  async startSidecarContainer(): Promise<{ containerId: string }> {
    return { containerId: `poc-sidecar-${crypto.randomUUID()}` };
  }
}