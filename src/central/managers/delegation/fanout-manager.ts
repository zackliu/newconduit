import { randomUUID } from 'node:crypto';
import type { Clock, CreateFanoutGroupResult, FanoutGroupMember, FanoutGroupRecord, RuntimeStorage } from '../../../shared';

export interface OpenFanoutGroupInput {
  parentSessionId: string;
  parentTurnSeq: number;
  parentRequestId: string;
  caseId: string;
  delegateId: string;
  input: string;
  deviceRefs: string[];
}

export type FanoutMemberOutcome =
  | { status: 'completed'; result: string }
  | { status: 'failed'; code: string; message: string };

export interface RecordFanoutOutcomeResult {
  group: FanoutGroupRecord;
  /** Present only on the transition that settles the whole group, so the parent tool request is answered exactly once. */
  settledAggregate?: string;
}

/**
 * Owns the durable fan-out group: a single parent tool request that targets many devices. It records each member
 * call's terminal outcome under revision CAS and, on the transition where the last member terminalizes, produces one
 * aggregated result that honestly lists every device's completed observation or failure. Settlement is idempotent, so
 * a redelivered completion or a post-restart reconcile never answers the parent twice.
 */
export class FanoutManager {
  constructor(
    private readonly tenantId: string,
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock
  ) {}

  async openGroup(input: OpenFanoutGroupInput): Promise<CreateFanoutGroupResult> {
    const now = this.clock.now();
    const group: FanoutGroupRecord = {
      groupId: randomUUID(),
      tenantId: this.tenantId,
      parentSessionId: input.parentSessionId,
      parentTurnSeq: input.parentTurnSeq,
      parentRequestId: input.parentRequestId,
      caseId: input.caseId,
      delegateId: input.delegateId,
      input: input.input,
      members: input.deviceRefs.map((deviceRef) => ({
        deviceRef,
        status: 'starting' as const,
        updatedAt: now
      })),
      status: 'open',
      deliveryStatus: 'pending',
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    return this.storage.createFanoutGroup(group);
  }

  async readGroupByRequest(parentSessionId: string, parentRequestId: string): Promise<FanoutGroupRecord | undefined> {
    return (await this.storage.readFanoutGroups()).find((group) =>
      group.parentSessionId === parentSessionId && group.parentRequestId === parentRequestId);
  }

  async readGroupByMember(delegationCallId: string): Promise<FanoutGroupRecord | undefined> {
    return (await this.storage.readFanoutGroups()).find((group) =>
      group.members.some((member) => member.delegationCallId === delegationCallId));
  }

  async attachMemberCall(groupId: string, deviceRef: string, delegationCallId: string): Promise<FanoutGroupRecord> {
    for (;;) {
      const group = await this.requireGroup(groupId);
      const member = group.members.find((candidate) => candidate.deviceRef === deviceRef);
      if (!member) {
        throw new Error(`Fan-out group ${groupId} has no member ${deviceRef}`);
      }
      if (member.delegationCallId === delegationCallId && member.status !== 'starting') {
        return group;
      }
      if (member.status !== 'starting') {
        throw new Error(`Fan-out member ${groupId}/${deviceRef} is already attached to another call`);
      }
      const now = this.clock.now();
      const next: FanoutGroupRecord = {
        ...group,
        members: group.members.map((candidate) => candidate.deviceRef === deviceRef
          ? { ...candidate, delegationCallId, status: 'pending', updatedAt: now }
          : candidate),
        revision: group.revision + 1,
        updatedAt: now
      };
      if (await this.storage.compareAndSetFanoutGroup(group.revision, next)) {
        return next;
      }
    }
  }

  async recordStartupFailure(groupId: string, deviceRef: string, code: string, message: string): Promise<RecordFanoutOutcomeResult> {
    return this.recordOutcomeInGroup(
      groupId,
      (member) => member.deviceRef === deviceRef,
      { status: 'failed', code, message }
    );
  }

  async recordOutcome(delegationCallId: string, outcome: FanoutMemberOutcome): Promise<RecordFanoutOutcomeResult | undefined> {
    const group = await this.readGroupByMember(delegationCallId);
    if (!group) {
      return undefined;
    }
    return this.recordOutcomeInGroup(
      group.groupId,
      (member) => member.delegationCallId === delegationCallId,
      outcome
    );
  }

  async markDelivered(groupId: string): Promise<FanoutGroupRecord> {
    for (;;) {
      const group = await this.requireGroup(groupId);
      if (group.deliveryStatus === 'delivered') {
        return group;
      }
      if (group.status !== 'settled' || group.aggregate === undefined) {
        throw new Error(`Fan-out group ${groupId} cannot be delivered before settlement`);
      }
      const next: FanoutGroupRecord = {
        ...group,
        deliveryStatus: 'delivered',
        revision: group.revision + 1,
        updatedAt: this.clock.now()
      };
      if (await this.storage.compareAndSetFanoutGroup(group.revision, next)) {
        return next;
      }
    }
  }

  private async recordOutcomeInGroup(
    groupId: string,
    matches: (member: FanoutGroupMember) => boolean,
    outcome: FanoutMemberOutcome
  ): Promise<RecordFanoutOutcomeResult> {
    for (;;) {
      const group = await this.requireGroup(groupId);
      if (group.status === 'settled') {
        return { group };
      }
      const member = group.members.find(matches);
      if (!member) {
        throw new Error(`Fan-out group ${groupId} does not contain the requested member`);
      }
      const now = this.clock.now();
      const members = member.status === 'starting' || member.status === 'pending'
        ? group.members.map((candidate) => matches(candidate) ? this.applyOutcome(candidate, outcome, now) : candidate)
        : group.members;
      const allTerminal = members.every((candidate) => candidate.status === 'completed' || candidate.status === 'failed');
      if (member.status === 'completed' || member.status === 'failed') {
        return { group };
      }
      const aggregate = allTerminal ? this.aggregate(members) : undefined;
      const next: FanoutGroupRecord = {
        ...group,
        members,
        status: allTerminal ? 'settled' : 'open',
        ...(aggregate !== undefined ? { aggregate } : {}),
        revision: group.revision + 1,
        updatedAt: now
      };
      if (await this.storage.compareAndSetFanoutGroup(group.revision, next)) {
        return { group: next, ...(aggregate !== undefined ? { settledAggregate: aggregate } : {}) };
      }
    }
  }

  private async requireGroup(groupId: string): Promise<FanoutGroupRecord> {
    const group = await this.storage.readFanoutGroup(groupId);
    if (!group || group.tenantId !== this.tenantId) {
      throw new Error(`Fan-out group ${groupId} was not found`);
    }
    return group;
  }

  private applyOutcome(member: FanoutGroupMember, outcome: FanoutMemberOutcome, now: string): FanoutGroupMember {
    if (outcome.status === 'completed') {
      return { ...member, status: 'completed', result: outcome.result, updatedAt: now };
    }
    return { ...member, status: 'failed', failure: { code: outcome.code, message: outcome.message }, updatedAt: now };
  }

  private aggregate(members: FanoutGroupMember[]): string {
    const devices = members.map((member) => {
      if (member.status === 'completed') {
        let observation: unknown = member.result ?? '';
        try {
          observation = JSON.parse(member.result ?? '');
        } catch {
          observation = member.result ?? '';
        }
        return { deviceRef: member.deviceRef, status: 'completed', observation };
      }
      return { deviceRef: member.deviceRef, status: 'failed', error: `${member.failure?.code ?? 'failed'}: ${member.failure?.message ?? ''}` };
    });
    const completed = members.filter((member) => member.status === 'completed').length;
    return JSON.stringify({
      scope: 'all',
      summary: { total: members.length, completed, failed: members.length - completed },
      devices
    });
  }
}
