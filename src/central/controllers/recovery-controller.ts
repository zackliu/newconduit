import type { WorkspaceSnapshot } from '../../shared';

export interface VolumeRestoreAdapter {
  restoreDirectoryToVolume(sourceDirectory: string, volumePath: string): Promise<void>;
}

export class RecoveryController {
  constructor(private readonly volumeAdapter: VolumeRestoreAdapter) {}

  async restoreForResume(snapshot: WorkspaceSnapshot, target: { workspaceVolume: string; copilotSessionVolume: string }): Promise<void> {
    await this.volumeAdapter.restoreDirectoryToVolume(snapshot.workspaceVolumePath, target.workspaceVolume);
    await this.volumeAdapter.restoreDirectoryToVolume(snapshot.copilotSessionVolumePath, target.copilotSessionVolume);
  }
}