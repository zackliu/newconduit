export type SnapshotPartName = 'workspace' | 'agent-state';

export interface SnapshotPart {
  name: SnapshotPartName;
  path: string;
}

export interface WorkspaceSnapshot {
  snapshotId: string;
  sessionId: string;
  baseEventCursor: number;
  location: string;
  parts: SnapshotPart[];
  createdAt: string;
  restoreHints: Record<string, string>;
}

export interface SnapshotCaptureRef {
  snapshotId: string;
  location: string;
}

export interface SnapshotRestoreRef {
  snapshotId: string;
  location: string;
  parts: SnapshotPart[];
}