import { CopilotProcessAdapter, DockerWorkspaceAdapter, WebPubSubClientAdapter } from './adapters';

export class SidecarDaemon {
  private readonly webPubSubAdapter = new WebPubSubClientAdapter();
  private readonly workspaceAdapter = new DockerWorkspaceAdapter();
  private readonly copilotProcessAdapter = new CopilotProcessAdapter();

  async connect(accessUrl: string): Promise<void> {
    await this.webPubSubAdapter.connect(accessUrl);
  }

  async startCopilot(input: { workspaceVolume: string; copilotSessionVolume: string }): Promise<void> {
    const mounted = this.workspaceAdapter.mount(input);
    await this.copilotProcessAdapter.start(mounted);
  }
}