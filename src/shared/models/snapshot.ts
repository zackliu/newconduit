export type SnapshotPartName = 'workspace' | 'agent-state';

/**
 * A snapshot is an opaque handle envelope. `storageClass` names the concrete driver central recorded from the
 * worker; `handle` is opaque to central (only the driver's data-half/control-half interpret it); `parts` are
 * semantic names, not filesystem paths. Central never assumes a path or backend prefix.
 */
export interface WorkspaceSnapshot {
  snapshotId: string;
  sessionId: string;
  storageClass: string;
  handle: string;
  parts: SnapshotPartName[];
  baseEventCursor: number;
  size?: number;
  checksum?: string;
  createdAt: string;
}

export interface SnapshotCaptureRef {
  snapshotId: string;
  storageClass: string;
  handle: string;
}

export interface SnapshotRestoreRef {
  snapshotId: string;
  storageClass: string;
  handle: string;
  parts: SnapshotPartName[];
}