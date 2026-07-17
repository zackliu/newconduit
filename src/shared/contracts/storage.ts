import type { CreateDelegationResult, DelegationRecord, HostPoolInstanceRecord, RuntimeEvent, SessionRecord, WorkerRecord, WorkspaceSnapshot } from '../models';

export interface RuntimeStorage {
  createSession(session: SessionRecord): Promise<{ session: SessionRecord; created: boolean }>;
  writeSession(session: SessionRecord): Promise<void>;
  readSession(sessionId: string): Promise<SessionRecord | undefined>;
  readSessions(): Promise<SessionRecord[]>;
  appendEvent(event: RuntimeEvent): Promise<RuntimeEvent>;
  readEvents(sessionId: string, afterSequence: number): Promise<RuntimeEvent[]>;
  writeWorker(worker: WorkerRecord): Promise<void>;
  readWorker(workerId: string): Promise<WorkerRecord | undefined>;
  readWorkers(): Promise<WorkerRecord[]>;
  writeHostPoolInstance(instance: HostPoolInstanceRecord): Promise<void>;
  readHostPoolInstance(instanceId: string): Promise<HostPoolInstanceRecord | undefined>;
  readHostPoolInstances(): Promise<HostPoolInstanceRecord[]>;
  writeSnapshot(snapshot: WorkspaceSnapshot): Promise<void>;
  readSnapshot(sessionId: string, snapshotId: string): Promise<WorkspaceSnapshot | undefined>;
  createDelegation(delegation: DelegationRecord): Promise<CreateDelegationResult>;
  compareAndSetDelegation(expectedRevision: number, delegation: DelegationRecord): Promise<boolean>;
  readDelegation(delegationId: string): Promise<DelegationRecord | undefined>;
  readDelegationByKey(parentSessionId: string, delegateId: string): Promise<DelegationRecord | undefined>;
  readDelegations(): Promise<DelegationRecord[]>;
}