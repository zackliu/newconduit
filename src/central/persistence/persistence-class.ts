import type { Clock, RuntimeStorage, SessionRecord, SnapshotCaptureRef, SnapshotPartName, SnapshotRestoreRef, WorkspaceSnapshot } from '../../shared';

export type StorageAttachmentKind = 'worker-pull' | 'host-managed';

/**
 * The central-side (control-half) of a storage driver. A session resolves exactly one storage class by the
 * `storageClass` id the worker reported at assignment; central asks the resolved class instead of branching on
 * policy values. `attachmentKind` says who moves bytes: `worker-pull` hands the worker an opaque capture/restore
 * handle to move; `host-managed` moves nothing (the host/agent keeps its own state). The `handle` inside a
 * capture/restore ref is opaque to central.
 */
export interface StorageClass {
  readonly classId: string;
  readonly attachmentKind: StorageAttachmentKind;
  planCapture(session: SessionRecord): SnapshotCaptureRef | undefined;
  planRestore(session: SessionRecord): Promise<SnapshotRestoreRef | undefined>;
  recordCapture(session: SessionRecord, input: { snapshotId: string; parts: SnapshotPartName[] }): Promise<WorkspaceSnapshot | undefined>;
}

/**
 * Volume-snapshot storage (worker-pull): central allocates a session-addressed snapshot handle and records what
 * the worker's data-half captured. The `handle` is opaque to central; only the driver's data-half interprets it.
 */
export class VolumeSnapshotStorageClass implements StorageClass {
  readonly classId = 'volume-snapshot';
  readonly attachmentKind: StorageAttachmentKind = 'worker-pull';

  constructor(private readonly storage: RuntimeStorage, private readonly clock: Clock) {}

  planCapture(session: SessionRecord): SnapshotCaptureRef {
    const snapshotId = crypto.randomUUID();
    return { snapshotId, storageClass: this.classId, handle: this.buildHandle(session.sessionId, snapshotId) };
  }

  async planRestore(session: SessionRecord): Promise<SnapshotRestoreRef | undefined> {
    if (!session.latestSnapshotRef) {
      return undefined;
    }
    const snapshot = await this.storage.readSnapshot(session.sessionId, session.latestSnapshotRef);
    if (!snapshot) {
      return undefined;
    }
    return { snapshotId: snapshot.snapshotId, storageClass: snapshot.storageClass, handle: snapshot.handle, parts: snapshot.parts };
  }

  async recordCapture(session: SessionRecord, input: { snapshotId: string; parts: SnapshotPartName[] }): Promise<WorkspaceSnapshot> {
    const snapshot: WorkspaceSnapshot = {
      snapshotId: input.snapshotId,
      sessionId: session.sessionId,
      storageClass: this.classId,
      handle: this.buildHandle(session.sessionId, input.snapshotId),
      parts: input.parts,
      baseEventCursor: session.eventCursor,
      createdAt: this.clock.now()
    };
    await this.storage.writeSnapshot(snapshot);
    return snapshot;
  }

  private buildHandle(sessionId: string, snapshotId: string): string {
    return `${sessionId}/${snapshotId}`;
  }
}

/**
 * Host-managed storage: the host/agent keeps its own workspace and session files on a long-lived worker, so
 * central plans no capture and no restore and moves no bytes. "No snapshot" is this class's behavior, not a
 * central special case.
 */
export class HostManagedStorageClass implements StorageClass {
  readonly classId = 'host-managed';
  readonly attachmentKind: StorageAttachmentKind = 'host-managed';

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
