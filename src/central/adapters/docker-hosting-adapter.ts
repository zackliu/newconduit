export class DockerHostingAdapter {
  async startSidecarContainer(): Promise<{ containerId: string }> {
    return { containerId: `poc-sidecar-${crypto.randomUUID()}` };
  }
}