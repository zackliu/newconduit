import { randomUUID } from 'node:crypto';
import type { Clock, FanoutGroupMember, FanoutGroupRecord, RuntimeStorage } from '../../../shared';

export interface OpenFanoutGroupInput {
  parentSessionId: string;
  parentTurnSeq: number;
  parentRequestId: string;
  caseId: string;
  members: { deviceRef: string; delegationCallId: string }[];
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

  async openGroup(input: OpenFanoutGroupInput): Promise<FanoutGroupRecord> {
    const now = this.clock.now();
    const group: FanoutGroupRecord = {
      groupId: randomUUID(),
      tenantId: this.tenantId,
      parentSessionId: input.parentSessionId,
      parentTurnSeq: input.parentTurnSeq,
      parentRequestId: input.parentRequestId,
      caseId: input.caseId,
      members: input.members.map((member) => ({
        deviceRef: member.deviceRef,
        delegationCallId: member.delegationCallId,
        status: 'pending' as const,
        updatedAt: now
      })),
      status: 'open',
      revision: 1,
      createdAt: now,
      updatedAt: now
    };
    return (await this.storage.createFanoutGroup(group)).group;
  }

  async readGroupByMember(delegationCallId: string): Promise<FanoutGroupRecord | undefined> {
    return (await this.storage.readFanoutGroups()).find((group) =>
      group.members.some((member) => member.delegationCallId === delegationCallId));
  }

  async recordOutcome(delegationCallId: string, outcome: FanoutMemberOutcome): Promise<RecordFanoutOutcomeResult | undefined> {
    for (;;) {
      const group = await this.readGroupByMember(delegationCallId);
      if (!group) {
        return undefined;
      }
      if (group.status === 'settled') {
        return { group };
      }
      const member = group.members.find((candidate) => candidate.delegationCallId === delegationCallId);
      if (!member) {
        return undefined;
      }
      const now = this.clock.now();
      const members = member.status === 'pending'
        ? group.members.map((candidate) => candidate.delegationCallId === delegationCallId ? this.applyOutcome(candidate, outcome, now) : candidate)
        : group.members;
      const allTerminal = members.every((candidate) => candidate.status !== 'pending');
      // Nothing to persist: this member was already recorded and the group still has pending siblings.
      if (member.status !== 'pending' && !allTerminal) {
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
