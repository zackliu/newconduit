export class CopilotProcessAdapter {
  async start(input: { workspaceVolume: string; copilotSessionVolume: string }): Promise<void> {
    if (!input.workspaceVolume || !input.copilotSessionVolume) {
      throw new Error('workspaceVolume and copilotSessionVolume are required');
    }
  }

  async pauseAtTurnBoundary(): Promise<void> {
    return;
  }
}