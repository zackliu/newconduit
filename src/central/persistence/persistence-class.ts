import type { Clock, RuntimeStorage, SessionRecord, SnapshotCaptureRef, SnapshotPart, SnapshotRestoreRef, WorkspaceSnapshot } from '../../shared';

const SNAPSHOT_RESTORE_HINTS: Record<string, string> = { mode: 'restart-with-context' };

/**
 * Selects how a paused session's continuity material is captured and restored. A session resolves exactly one
 * persistence class from its AgentSpec; central asks the resolved class instead of branching on policy values.
 */
export interface PersistenceClass {
  planCapture(session: SessionRecord): SnapshotCaptureRef | undefined;
  planRestore(session: SessionRecord): Promise<SnapshotRestoreRef | undefined>;
  recordCapture(session: SessionRecord, input: { snapshotId: string; parts: SnapshotPart[] }): Promise<WorkspaceSnapshot | undefined>;
}

/**
 * Volume-snapshot persistence: central allocates a session-addressed snapshot and records what the sidecar captured.
 */
export class VolumeSnapshotPersistenceClass implements PersistenceClass {
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

/**
 * Copilot self-managed persistence: the agent keeps its own workspace and session files on a long-lived worker,
 * so central plans no capture and no restore. "No snapshot" is this class's behavior, not a central special case.
 */
export class CopilotManagedLocalPersistenceClass implements PersistenceClass {
  planCapture(): undefined {
    return undefined;
  }

  async planRestore(): Promise<undefined> {
    return undefined;
  }

  async recordCapture(): Promise<undefined> {
    return undefined;
  }
}
