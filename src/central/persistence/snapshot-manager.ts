import type { Clock, RuntimeStorage, SessionRecord, SnapshotCaptureRef, SnapshotPartName, SnapshotRestoreRef, WorkspaceSnapshot } from '../../shared';
import { HostManagedStorageClass, VolumeSnapshotStorageClass, type StorageAttachmentKind, type StorageClass } from './persistence-class';

/**
 * Resolves the per-session storage class from the `storageClass` driver id bound to the session at assignment and
 * delegates capture/restore to it.
 *
 * The manager never reads worker bytes and never branches on policy literals; the resolved class decides whether a
 * session uses session-addressed volume snapshots (worker-pull) or leaves persistence to a self-managing host.
 */
export class SnapshotManager {
  private readonly storageClasses: ReadonlyMap<string, StorageClass>;

  constructor(storage: RuntimeStorage, clock: Clock) {
    const classes: StorageClass[] = [
      new VolumeSnapshotStorageClass(storage, clock),
      new HostManagedStorageClass()
    ];
    this.storageClasses = new Map(classes.map((storageClass) => [storageClass.classId, storageClass]));
  }

  attachmentKind(session: SessionRecord): StorageAttachmentKind {
    return this.resolve(session).attachmentKind;
  }

  planCapture(session: SessionRecord): SnapshotCaptureRef | undefined {
    return this.resolve(session).planCapture(session);
  }

  async planRestore(session: SessionRecord): Promise<SnapshotRestoreRef | undefined> {
    return this.resolve(session).planRestore(session);
  }

  async recordCapture(session: SessionRecord, input: { snapshotId: string; parts: SnapshotPartName[] }): Promise<WorkspaceSnapshot | undefined> {
    return this.resolve(session).recordCapture(session, input);
  }

  private resolve(session: SessionRecord): StorageClass {
    if (!session.storageClass) {
      throw new Error(`session ${session.sessionId} has no storageClass bound`);
    }
    const storageClass = this.storageClasses.get(session.storageClass);
    if (!storageClass) {
      throw new Error(`no storageClass registered for id: ${session.storageClass}`);
    }
    return storageClass;
  }
}
