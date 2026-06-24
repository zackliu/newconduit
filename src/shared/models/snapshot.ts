export interface WorkspaceSnapshot {
  snapshotId: string;
  sessionId: string;
  baseEventCursor: number;
  storageLocation: string;
  workspaceVolumePath: string;
  copilotSessionVolumePath: string;
  createdAt: string;
  restoreHints: Record<string, string>;
}