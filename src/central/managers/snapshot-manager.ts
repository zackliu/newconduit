import type { Clock, RuntimeStorage, SessionRecord, SnapshotCaptureRef, SnapshotPart, SnapshotRestoreRef, WorkspaceSnapshot } from '../../shared';

const SNAPSHOT_RESTORE_HINTS: Record<string, string> = { mode: 'restart-with-context' };

/**
 * Owns the session-addressed snapshot record so a paused session can be restored onto any later worker.
 *
 * The manager never reads worker volume bytes; the sidecar captures and restores the parts. The manager
 * allocates the snapshot identity, hands capture/restore refs to commands, and records what the sidecar captured.
 */
export class SnapshotManager {
  constructor(private readonly storage: RuntimeStorage, private readonly clock: Clock) {}

  planCapture(session: SessionRecord): SnapshotCaptureRef {
    const snapshotId = crypto.randomUUID();
    return { snapshotId, location: this.buildLocation(session.sessionId, snapshotId) };
  }

  async planRestore(session: SessionRecord): Promise<SnapshotRestoreRef | undefined> {
    if (!session.latestSnapshotRef) {
      return undefined;
    }
    const snapshot = await this.storage.readSnapshot(session.sessionId, session.latestSnapshotRef);
    if (!snapshot) {
      return undefined;
    }
    return { snapshotId: snapshot.snapshotId, location: snapshot.location, parts: snapshot.parts };
  }

  async recordCapture(session: SessionRecord, input: { snapshotId: string; parts: SnapshotPart[] }): Promise<WorkspaceSnapshot> {
    const snapshot: WorkspaceSnapshot = {
      snapshotId: input.snapshotId,
      sessionId: session.sessionId,
      baseEventCursor: session.eventCursor,
      location: this.buildLocation(session.sessionId, input.snapshotId),
      parts: input.parts,
      createdAt: this.clock.now(),
      restoreHints: SNAPSHOT_RESTORE_HINTS
    };
    await this.storage.writeSnapshot(snapshot);
    return snapshot;
  }

  private buildLocation(sessionId: string, snapshotId: string): string {
    return `${sessionId}/${snapshotId}`;
  }
}
