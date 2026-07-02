import type { Clock, RuntimeStorage, SessionRecord, SnapshotCaptureRef, SnapshotPart, SnapshotRestoreRef, WorkspaceSnapshot } from '../../shared';
import { CopilotManagedLocalPersistenceClass, VolumeSnapshotPersistenceClass, type PersistenceClass } from './persistence-class';

/**
 * Resolves the per-session persistence class from the AgentSpec and delegates capture/restore to it.
 *
 * The manager never reads worker volume bytes and never branches on policy literals; the resolved class decides
 * whether a session uses session-addressed volume snapshots or leaves persistence to a self-managing agent.
 */
export class SnapshotManager {
  private readonly persistenceByAgentStatePolicy: ReadonlyMap<string, PersistenceClass>;

  constructor(storage: RuntimeStorage, clock: Clock) {
    const persistenceClasses: PersistenceClass[] = [
      new VolumeSnapshotPersistenceClass(storage, clock),
      new CopilotManagedLocalPersistenceClass()
    ];
    this.persistenceByAgentStatePolicy = new Map(persistenceClasses.map((persistenceClass) => [persistenceClass.classId, persistenceClass]));
  }

  planCapture(session: SessionRecord): SnapshotCaptureRef | undefined {
    return this.resolve(session).planCapture(session);
  }

  async planRestore(session: SessionRecord): Promise<SnapshotRestoreRef | undefined> {
    return this.resolve(session).planRestore(session);
  }

  async recordCapture(session: SessionRecord, input: { snapshotId: string; parts: SnapshotPart[] }): Promise<WorkspaceSnapshot | undefined> {
    return this.resolve(session).recordCapture(session, input);
  }

  private resolve(session: SessionRecord): PersistenceClass {
    const persistence = this.persistenceByAgentStatePolicy.get(session.resolvedAgentSpec.agentStatePolicy);
    if (!persistence) {
      throw new Error(`no persistentClass registered for agentStatePolicy: ${session.resolvedAgentSpec.agentStatePolicy}`);
    }
    return persistence;
  }
}
