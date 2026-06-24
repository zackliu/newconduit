import type { RuntimeEvent, SessionRecord, WorkerRecord, WorkspaceSnapshot } from '../models';

export interface RuntimeStorage {
  writeSession(session: SessionRecord): Promise<void>;
  readSession(sessionId: string): Promise<SessionRecord | undefined>;
  appendEvent(event: RuntimeEvent): Promise<RuntimeEvent>;
  readEvents(sessionId: string, afterSequence: number): Promise<RuntimeEvent[]>;
  writeWorker(worker: WorkerRecord): Promise<void>;
  readWorkers(): Promise<WorkerRecord[]>;
  writeSnapshot(snapshot: WorkspaceSnapshot): Promise<void>;
  readSnapshot(sessionId: string, snapshotId: string): Promise<WorkspaceSnapshot | undefined>;
}