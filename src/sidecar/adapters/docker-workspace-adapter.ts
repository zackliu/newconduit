export class DockerWorkspaceAdapter {
  mount(input: { workspaceVolume: string; copilotSessionVolume: string }): { workspaceVolume: string; copilotSessionVolume: string } {
    return input;
  }
}