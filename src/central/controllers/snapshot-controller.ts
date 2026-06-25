import type { Clock, RuntimeStorage, SessionRecord, WorkspaceSnapshot } from '../../shared';

export interface VolumeSnapshotAdapter {
  copyVolumeToDirectory(volumePath: string, targetDirectory: string): Promise<void>;
}

/**
 * Coordinates a durable pause boundary by capturing workspace and agent state volumes under the same session snapshot record.
 */
export class SnapshotController {
  constructor(
    private readonly storage: RuntimeStorage,
    private readonly volumeAdapter: VolumeSnapshotAdapter,
    private readonly clock: Clock,
    private readonly dataRoot: string
  ) {}

  async snapshot(session: SessionRecord, input: { workspaceVolume: string; copilotSessionVolume: string }): Promise<WorkspaceSnapshot> {
    const snapshotId = crypto.randomUUID();
    const storageLocation = `${this.dataRoot}/sessions/${session.sessionId}/snapshots/${snapshotId}`;
    const workspaceVolumePath = `${storageLocation}/volumes/workspace`;
    const copilotSessionVolumePath = `${storageLocation}/volumes/copilot-session`;
    await this.volumeAdapter.copyVolumeToDirectory(input.workspaceVolume, workspaceVolumePath);
    await this.volumeAdapter.copyVolumeToDirectory(input.copilotSessionVolume, copilotSessionVolumePath);
    const snapshot: WorkspaceSnapshot = {
      snapshotId,
      sessionId: session.sessionId,
      baseEventCursor: session.eventCursor,
      storageLocation,
      workspaceVolumePath,
      copilotSessionVolumePath,
      createdAt: this.clock.now(),
      restoreHints: { mode: 'restart-with-context' }
    };
    await this.storage.writeSnapshot(snapshot);
    return snapshot;
  }
}