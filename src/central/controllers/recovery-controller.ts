import type { WorkspaceSnapshot } from '../../shared';
import type { DockerVolumeAdapter } from '../adapters';

export class RecoveryController {
  constructor(private readonly volumeAdapter: DockerVolumeAdapter) {}

  async restoreForResume(snapshot: WorkspaceSnapshot, target: { workspaceVolume: string; copilotSessionVolume: string }): Promise<void> {
    await this.volumeAdapter.restoreDirectoryToVolume(snapshot.workspaceVolumePath, target.workspaceVolume);
    await this.volumeAdapter.restoreDirectoryToVolume(snapshot.copilotSessionVolumePath, target.copilotSessionVolume);
  }
}