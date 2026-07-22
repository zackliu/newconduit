import { appendFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { CaseDeviceBindingRecord, CreateCaseDeviceBindingResult, CreateDelegationResult, CreateFanoutGroupResult, CreateInteractionResult, CreatePairingInviteResult, DelegationRecord, FanoutGroupRecord, HostPoolInstanceRecord, InteractionRecord, PairingInviteRecord, RuntimeEvent, RuntimeStorage, SessionRecord, WorkerRecord, WorkspaceSnapshot } from '../../shared';

// Windows can transiently reject an atomic replace or a read (EPERM/EACCES/EBUSY) when the same path is momentarily
// held by a concurrent reader or another in-flight replace. The operation stays correct; only its timing is racy.
const TRANSIENT_FS_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LocalFileStorage implements RuntimeStorage {
  private delegationWriteSequence: Promise<void> = Promise.resolve();
  private interactionWriteSequence: Promise<void> = Promise.resolve();
  private pairingInviteWriteSequence: Promise<void> = Promise.resolve();
  private caseDeviceWriteSequence: Promise<void> = Promise.resolve();
  private fanoutGroupWriteSequence: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async createSession(session: SessionRecord): Promise<{ session: SessionRecord; created: boolean }> {
    const path = join(this.root, 'sessions', session.sessionId, 'session.json');
    if (await this.createJson(path, session)) {
      return { session, created: true };
    }
    const existing = await this.readSession(session.sessionId);
    if (!existing) {
      throw new Error(`session ${session.sessionId} exists but could not be read`);
    }
    return { session: existing, created: false };
  }

  async writeSession(session: SessionRecord): Promise<void> {
    await this.writeJson(join(this.root, 'sessions', session.sessionId, 'session.json'), session);
  }

  async readSession(sessionId: string): Promise<SessionRecord | undefined> {
    return this.readJson(join(this.root, 'sessions', sessionId, 'session.json'));
  }

  async readSessions(): Promise<SessionRecord[]> {
    const directory = join(this.root, 'sessions');
    try {
      const entries = await readdir(directory);
      const sessions = await Promise.all(entries.map((entry) => this.readJson<SessionRecord>(join(directory, entry, 'session.json'))));
      return sessions.filter((session): session is SessionRecord => session !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async appendEvent(event: RuntimeEvent): Promise<RuntimeEvent> {
    if (event.sessionId) {
      const path = join(this.root, 'sessions', event.sessionId, 'events.jsonl');
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
      return event;
    }
    if (!event.workerId) {
      throw new Error('sessionId or workerId is required for event append');
    }
    const path = join(this.root, 'workers', `${event.workerId}.events.jsonl`);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  }

  async readEvents(sessionId: string, afterSequence: number): Promise<RuntimeEvent[]> {
    const text = await this.readText(join(this.root, 'sessions', sessionId, 'events.jsonl'));
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as RuntimeEvent).filter((event) => event.sequence > afterSequence);
  }

  async writeWorker(worker: WorkerRecord): Promise<void> {
    await this.writeJson(join(this.root, 'workers', `${worker.workerId}.json`), worker);
  }

  async readWorker(workerId: string): Promise<WorkerRecord | undefined> {
    return this.readJson(join(this.root, 'workers', `${workerId}.json`));
  }

  async readWorkers(): Promise<WorkerRecord[]> {
    const directory = join(this.root, 'workers');
    try {
      const files = await readdir(directory);
      const workers = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => this.readJson<WorkerRecord>(join(directory, file))));
      return workers.filter((worker): worker is WorkerRecord => worker !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async writeHostPoolInstance(instance: HostPoolInstanceRecord): Promise<void> {
    await this.writeJson(join(this.root, 'host-pool-instances', `${instance.instanceId}.json`), instance);
  }

  async readHostPoolInstance(instanceId: string): Promise<HostPoolInstanceRecord | undefined> {
    return this.readJson(join(this.root, 'host-pool-instances', `${instanceId}.json`));
  }

  async readHostPoolInstances(): Promise<HostPoolInstanceRecord[]> {
    const directory = join(this.root, 'host-pool-instances');
    try {
      const files = await readdir(directory);
      const instances = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => this.readJson<HostPoolInstanceRecord>(join(directory, file))));
      return instances.filter((instance): instance is HostPoolInstanceRecord => instance !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async writeSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    await this.writeJson(join(this.root, 'snapshots', snapshot.sessionId, snapshot.snapshotId, 'snapshot.json'), snapshot);
  }

  async readSnapshot(sessionId: string, snapshotId: string): Promise<WorkspaceSnapshot | undefined> {
    return this.readJson(join(this.root, 'snapshots', sessionId, snapshotId, 'snapshot.json'));
  }

  async createDelegation(delegation: DelegationRecord): Promise<CreateDelegationResult> {
    return this.serializeDelegationWrite(async () => {
      const existingById = await this.readDelegation(delegation.delegationId);
      if (existingById) {
        return { delegation: existingById, created: false };
      }
      const existingByKey = await this.readDelegationByKey(delegation.parentSessionId, delegation.resolvedDelegate.id, delegation.targetRef);
      if (existingByKey) {
        return { delegation: existingByKey, created: false };
      }
      await this.writeDelegation(delegation);
      return { delegation, created: true };
    });
  }

  async compareAndSetDelegation(expectedRevision: number, delegation: DelegationRecord): Promise<boolean> {
    return this.serializeDelegationWrite(async () => {
      const current = await this.readDelegation(delegation.delegationId);
      if (!current || current.revision !== expectedRevision) {
        return false;
      }
      if (delegation.revision !== expectedRevision + 1) {
        throw new Error(`Delegation ${delegation.delegationId} revision must advance from ${expectedRevision} to ${expectedRevision + 1}`);
      }
      if (current.parentSessionId !== delegation.parentSessionId
        || current.resolvedDelegate.id !== delegation.resolvedDelegate.id
        || (current.targetRef ?? '') !== (delegation.targetRef ?? '')) {
        throw new Error(`Delegation ${delegation.delegationId} immutable relation key changed`);
      }
      await this.writeDelegation(delegation);
      return true;
    });
  }

  async readDelegation(delegationId: string): Promise<DelegationRecord | undefined> {
    return this.readJson(this.delegationPath(delegationId));
  }

  async readDelegationByKey(parentSessionId: string, delegateId: string, targetRef?: string): Promise<DelegationRecord | undefined> {
    const delegations = await this.readDelegations();
    // A terminal (failed/closed) Delegation is a closed relation: the next caller with a fresh idempotency key
    // must be able to open a new Delegation (and a fresh Child Session) for the same (parent, delegate). This is
    // what lets the Parent retry a scan after its paired device was lost mid-turn without being permanently
    // pinned to the dead relation. `targetRef` is part of the relation key: targeting device A then device B are
    // distinct relations, and a device-pinned target is never conflated with a pool (`any`) target.
    return delegations.find((delegation) =>
      delegation.parentSessionId === parentSessionId
      && delegation.resolvedDelegate.id === delegateId
      && (delegation.targetRef ?? '') === (targetRef ?? '')
      && delegation.status !== 'failed'
      && delegation.status !== 'closed');
  }

  async readDelegations(): Promise<DelegationRecord[]> {
    const directory = join(this.root, 'delegations');
    try {
      const files = await readdir(directory);
      const delegations = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => this.readJson<DelegationRecord>(join(directory, file))));
      return delegations.filter((delegation): delegation is DelegationRecord => delegation !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async createInteraction(interaction: InteractionRecord): Promise<CreateInteractionResult> {
    return this.serializeInteractionWrite(async () => {
      const existingById = await this.readInteraction(interaction.interactionId);
      if (existingById) {
        return { interaction: existingById, created: false };
      }
      const existingByAdapterRequest = await this.readInteractionByAdapterRequest(
        interaction.ownerSessionId,
        interaction.requestLeaseId,
        interaction.adapterRequestId
      );
      if (existingByAdapterRequest) {
        return { interaction: existingByAdapterRequest, created: false };
      }
      await this.writeInteraction(interaction);
      return { interaction, created: true };
    });
  }

  async compareAndSetInteraction(expectedRevision: number, interaction: InteractionRecord): Promise<boolean> {
    return this.serializeInteractionWrite(async () => {
      const current = await this.readInteraction(interaction.interactionId);
      if (!current || current.revision !== expectedRevision) {
        return false;
      }
      if (interaction.revision !== expectedRevision + 1) {
        throw new Error(`Interaction ${interaction.interactionId} revision must advance from ${expectedRevision} to ${expectedRevision + 1}`);
      }
      if (current.tenantId !== interaction.tenantId
        || current.ownerSessionId !== interaction.ownerSessionId
        || current.ownerTurnSeq !== interaction.ownerTurnSeq
        || current.adapterRequestId !== interaction.adapterRequestId
        || current.requestLeaseId !== interaction.requestLeaseId) {
        throw new Error(`Interaction ${interaction.interactionId} immutable owner binding changed`);
      }
      await this.writeInteraction(interaction);
      return true;
    });
  }

  async readInteraction(interactionId: string): Promise<InteractionRecord | undefined> {
    return this.readJson(this.interactionPath(interactionId));
  }

  async readInteractionByAdapterRequest(ownerSessionId: string, requestLeaseId: string, adapterRequestId: string): Promise<InteractionRecord | undefined> {
    const interactions = await this.readInteractions();
    return interactions.find((interaction) => interaction.ownerSessionId === ownerSessionId
      && interaction.requestLeaseId === requestLeaseId
      && interaction.adapterRequestId === adapterRequestId);
  }

  async readInteractions(): Promise<InteractionRecord[]> {
    const directory = join(this.root, 'interactions');
    try {
      const files = await readdir(directory);
      const interactions = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => this.readJson<InteractionRecord>(join(directory, file))));
      return interactions.filter((interaction): interaction is InteractionRecord => interaction !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async readInteractionsBySession(sessionId: string): Promise<InteractionRecord[]> {
    return (await this.readInteractions()).filter((interaction) => interaction.views.some((view) => view.sessionId === sessionId));
  }

  async createPairingInvite(invite: PairingInviteRecord): Promise<CreatePairingInviteResult> {
    return this.serializePairingInviteWrite(async () => {
      const existing = await this.readPairingInvite(invite.inviteId);
      if (existing) {
        return { invite: existing, created: false };
      }
      await this.writeJson(this.pairingInvitePath(invite.inviteId), invite);
      return { invite, created: true };
    });
  }

  async compareAndSetPairingInvite(expectedRevision: number, invite: PairingInviteRecord): Promise<boolean> {
    return this.serializePairingInviteWrite(async () => {
      const current = await this.readPairingInvite(invite.inviteId);
      if (!current || current.revision !== expectedRevision) {
        return false;
      }
      if (invite.revision !== expectedRevision + 1) {
        throw new Error(`Pairing invite ${invite.inviteId} revision must advance from ${expectedRevision} to ${expectedRevision + 1}`);
      }
      if (current.tenantId !== invite.tenantId || current.caseId !== invite.caseId) {
        throw new Error(`Pairing invite ${invite.inviteId} immutable relation key changed`);
      }
      await this.writeJson(this.pairingInvitePath(invite.inviteId), invite);
      return true;
    });
  }

  async readPairingInvite(inviteId: string): Promise<PairingInviteRecord | undefined> {
    return this.readJson(this.pairingInvitePath(inviteId));
  }

  async createCaseDeviceBinding(binding: CaseDeviceBindingRecord): Promise<CreateCaseDeviceBindingResult> {
    return this.serializeCaseDeviceWrite(async () => {
      const existing = await this.readCaseDeviceBinding(binding.caseId, binding.deviceRef);
      if (existing) {
        return { binding: existing, created: false };
      }
      await this.writeJson(this.caseDeviceBindingPath(binding.caseId, binding.deviceRef), binding);
      return { binding, created: true };
    });
  }

  async compareAndSetCaseDeviceBinding(expectedRevision: number, binding: CaseDeviceBindingRecord): Promise<boolean> {
    return this.serializeCaseDeviceWrite(async () => {
      const current = await this.readCaseDeviceBinding(binding.caseId, binding.deviceRef);
      if (!current || current.revision !== expectedRevision) {
        return false;
      }
      if (binding.revision !== expectedRevision + 1) {
        throw new Error(`Case device binding ${binding.caseId}/${binding.deviceRef} revision must advance from ${expectedRevision} to ${expectedRevision + 1}`);
      }
      if (current.tenantId !== binding.tenantId || current.deviceId !== binding.deviceId) {
        throw new Error(`Case device binding ${binding.caseId}/${binding.deviceRef} immutable identity changed`);
      }
      await this.writeJson(this.caseDeviceBindingPath(binding.caseId, binding.deviceRef), binding);
      return true;
    });
  }

  async readCaseDeviceBinding(caseId: string, deviceRef: string): Promise<CaseDeviceBindingRecord | undefined> {
    return this.readJson(this.caseDeviceBindingPath(caseId, deviceRef));
  }

  async readCaseDeviceBindings(caseId: string): Promise<CaseDeviceBindingRecord[]> {
    const directory = join(this.root, 'case-device-bindings', caseId);
    try {
      const files = await readdir(directory);
      const bindings = await Promise.all(
        files.filter((file) => file.endsWith('.json')).map((file) => this.readJson<CaseDeviceBindingRecord>(join(directory, file)))
      );
      return bindings.filter((binding): binding is CaseDeviceBindingRecord => binding !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async createFanoutGroup(group: FanoutGroupRecord): Promise<CreateFanoutGroupResult> {
    return this.serializeFanoutGroupWrite(async () => {
      const existingById = await this.readFanoutGroup(group.groupId);
      if (existingById) {
        return { group: existingById, created: false };
      }
      // One parent tool request opens at most one fan-out group: a redelivered/retried request re-attaches to the
      // existing group instead of double-fanning to the same devices.
      const existingByRequest = (await this.readFanoutGroups()).find((candidate) =>
        candidate.parentSessionId === group.parentSessionId && candidate.parentRequestId === group.parentRequestId);
      if (existingByRequest) {
        return { group: existingByRequest, created: false };
      }
      await this.writeJson(this.fanoutGroupPath(group.groupId), group);
      return { group, created: true };
    });
  }

  async compareAndSetFanoutGroup(expectedRevision: number, group: FanoutGroupRecord): Promise<boolean> {
    return this.serializeFanoutGroupWrite(async () => {
      const current = await this.readFanoutGroup(group.groupId);
      if (!current || current.revision !== expectedRevision) {
        return false;
      }
      if (group.revision !== expectedRevision + 1) {
        throw new Error(`Fan-out group ${group.groupId} revision must advance from ${expectedRevision} to ${expectedRevision + 1}`);
      }
      if (current.parentSessionId !== group.parentSessionId || current.parentRequestId !== group.parentRequestId) {
        throw new Error(`Fan-out group ${group.groupId} immutable parent key changed`);
      }
      await this.writeJson(this.fanoutGroupPath(group.groupId), group);
      return true;
    });
  }

  async readFanoutGroup(groupId: string): Promise<FanoutGroupRecord | undefined> {
    return this.readJson(this.fanoutGroupPath(groupId));
  }

  async readFanoutGroups(): Promise<FanoutGroupRecord[]> {
    const directory = join(this.root, 'fanout-groups');
    try {
      const files = await readdir(directory);
      const groups = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => this.readJson<FanoutGroupRecord>(join(directory, file))));
      return groups.filter((group): group is FanoutGroupRecord => group !== undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  // A runtime-state record must never be observed torn or empty: a concurrent reader mid-write once made central
  // read a live Worker as missing and stop its host. Write to a unique temp file, fsync it, then atomically rename
  // over the target, so any reader sees either the whole previous record or the whole next one, never a partial file.
  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(tempPath, 'w');
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.renameWithRetry(tempPath, path);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  private async renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(from, to);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (!TRANSIENT_FS_ERRORS.has(code) || attempt >= 40) {
          throw error;
        }
        await delay(Math.min(5 + attempt * 5, 50));
      }
    }
  }

  private async createJson(path: string, value: unknown): Promise<boolean> {
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  }

  private delegationPath(delegationId: string): string {
    return join(this.root, 'delegations', `${delegationId}.json`);
  }

  private interactionPath(interactionId: string): string {
    return join(this.root, 'interactions', `${interactionId}.json`);
  }

  private pairingInvitePath(inviteId: string): string {
    return join(this.root, 'pairing-invites', `${inviteId}.json`);
  }

  private caseDeviceBindingPath(caseId: string, deviceRef: string): string {
    return join(this.root, 'case-device-bindings', caseId, `${deviceRef}.json`);
  }

  private fanoutGroupPath(groupId: string): string {
    return join(this.root, 'fanout-groups', `${groupId}.json`);
  }

  private async writeDelegation(delegation: DelegationRecord): Promise<void> {
    await this.writeJson(this.delegationPath(delegation.delegationId), delegation);
  }

  private async writeInteraction(interaction: InteractionRecord): Promise<void> {
    await this.writeJson(this.interactionPath(interaction.interactionId), interaction);
  }

  private serializeDelegationWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.delegationWriteSequence.then(operation, operation);
    this.delegationWriteSequence = result.then(() => undefined, () => undefined);
    return result;
  }

  private serializeInteractionWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.interactionWriteSequence.then(operation, operation);
    this.interactionWriteSequence = result.then(() => undefined, () => undefined);
    return result;
  }

  private serializePairingInviteWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pairingInviteWriteSequence.then(operation, operation);
    this.pairingInviteWriteSequence = result.then(() => undefined, () => undefined);
    return result;
  }

  private serializeCaseDeviceWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.caseDeviceWriteSequence.then(operation, operation);
    this.caseDeviceWriteSequence = result.then(() => undefined, () => undefined);
    return result;
  }

  private serializeFanoutGroupWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.fanoutGroupWriteSequence.then(operation, operation);
    this.fanoutGroupWriteSequence = result.then(() => undefined, () => undefined);
    return result;
  }

  // Absence and corruption are different facts: a truly missing file is `undefined`, but an existing file that is
  // empty or unparseable is a storage-invariant failure and must fail loudly, never be reported as not-found.
  private async readJson<T>(path: string): Promise<T | undefined> {
    const text = await this.readRecordText(path);
    if (text === undefined) {
      return undefined;
    }
    if (text.length === 0) {
      throw new Error(`runtime state file ${path} is empty, not a valid record`);
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(`runtime state file ${path} is corrupt: ${(error as Error).message}`);
    }
  }

  // A continuously-existing record name always resolves to a whole file across an atomic replace, so ENOENT is a real
  // not-found and is returned immediately; only a transient Windows sharing rejection is retried briefly.
  private async readRecordText(path: string): Promise<string | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (code === 'ENOENT') {
          return undefined;
        }
        if (!TRANSIENT_FS_ERRORS.has(code) || attempt >= 40) {
          throw error;
        }
        await delay(Math.min(5 + attempt * 5, 50));
      }
    }
  }

  private async readText(path: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }
}