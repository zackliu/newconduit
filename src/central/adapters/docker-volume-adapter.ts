import type { LocalFileStorage } from '../storage/local-file-storage';

export class DockerVolumeAdapter {
  constructor(private readonly storage: LocalFileStorage) {}

  async copyVolumeToDirectory(volumePath: string, targetDirectory: string): Promise<void> {
    await this.storage.copyDirectory(volumePath, targetDirectory);
  }

  async restoreDirectoryToVolume(sourceDirectory: string, volumePath: string): Promise<void> {
    await this.storage.copyDirectory(sourceDirectory, volumePath);
  }
}