/**
 * A durable fan-out group: one parent tool request that targets more than one device (`target: { scope: 'all' }` or
 * an explicit `deviceRefs` list) opens ONE group whose members are the per-device delegated Child calls. The parent's
 * single tool interaction stays pending until every member call terminalizes; then Central publishes ONE aggregated
 * result that honestly reports each device's completed observation or failure.
 *
 * Fan-out must be durable, not an in-memory `Promise.all`: if Central restarts mid-scan the group and its member
 * outcomes survive, and the recovery reconcile re-checks the group and settles the parent instead of leaving the
 * parent turn hung. Each member is one delegated call keyed `(parentSessionId, delegateId, deviceRef)`, so a member
 * whose device is lost fails independently (`child_session_lost`) and appears as a partial failure in the aggregate,
 * while sibling devices still complete.
 */
export type FanoutMemberStatus = 'pending' | 'completed' | 'failed';

export interface FanoutGroupMember {
  /** The Central-authoritative case roster device this member call targets. */
  deviceRef: string;
  /** The delegated call correlated to this member. A pre-failed member (a device that could not start) still carries
   * a stable synthetic id so its failure is recorded exactly once. */
  delegationCallId: string;
  status: FanoutMemberStatus;
  /** The device's structured observation result (a JSON string), present only when `status` is `completed`. */
  result?: string;
  failure?: { code: string; message: string };
  updatedAt: string;
}

export type FanoutGroupStatus = 'open' | 'settled';

export interface FanoutGroupRecord {
  groupId: string;
  tenantId: string;
  parentSessionId: string;
  parentTurnSeq: number;
  /** The single parent tool request this group settles once all members terminalize. */
  parentRequestId: string;
  /** The recovery case the fan-out targeted (equal to `parentSessionId`); recorded for audit and roster scoping. */
  caseId: string;
  members: FanoutGroupMember[];
  status: FanoutGroupStatus;
  /** The aggregated tool result published to the parent, set exactly once at settlement. */
  aggregate?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFanoutGroupResult {
  group: FanoutGroupRecord;
  created: boolean;
}
