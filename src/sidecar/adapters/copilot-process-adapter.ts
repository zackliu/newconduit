import type { SidecarAgentProcessAdapter, SidecarWorkspaceMount } from '../contracts';

export class CopilotProcessAdapter implements SidecarAgentProcessAdapter {
  async start(input: SidecarWorkspaceMount): Promise<void> {
    if (!input.workspaceVolume || !input.copilotSessionVolume) {
      throw new Error('workspaceVolume and copilotSessionVolume are required');
    }
  }

  async pauseAtTurnBoundary(): Promise<void> {
    return;
  }
}