import type { LocalFileStorage } from '../storage/local-file-storage';
import type { VolumeRestoreAdapter } from '../controllers/recovery-controller';
import type { VolumeSnapshotAdapter } from '../controllers/snapshot-controller';

export class DockerVolumeAdapter implements VolumeSnapshotAdapter, VolumeRestoreAdapter {
  constructor(private readonly storage: LocalFileStorage) {}

  async copyVolumeToDirectory(volumePath: string, targetDirectory: string): Promise<void> {
    await this.storage.copyDirectory(volumePath, targetDirectory);
  }

  async restoreDirectoryToVolume(sourceDirectory: string, volumePath: string): Promise<void> {
    await this.storage.copyDirectory(sourceDirectory, volumePath);
  }
}