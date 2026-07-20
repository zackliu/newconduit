import type { InteractionKind } from './session';

export interface InteractionView {
  sessionId: string;
  turnSeq: number;
  role: 'owner' | 'parent_projection';
  source?: {
    ownerSessionId: string;
    agentSpecId: string;
  };
  requestedEventId: string;
  requestedProjected: boolean;
  respondedEventId?: string;
  respondedProjected: boolean;
  interruptedEventId?: string;
  interruptedProjected: boolean;
}

export interface InteractionResolution {
  response: unknown;
  principalId: string;
  viaSessionId: string;
  resolvedAt: string;
}

export interface InteractionInterruption {
  reason: 'owner_lease_lost' | 'owner_turn_failed' | 'owner_session_terminal';
  interruptedAt: string;
}

export interface InteractionDelivery {
  state: 'not_ready' | 'pending' | 'accepted' | 'abandoned';
  commandEventId?: string;
}

export interface InteractionRecord {
  interactionId: string;
  tenantId: string;
  kind: InteractionKind;
  request: unknown;
  ownerSessionId: string;
  ownerTurnSeq: number;
  adapterRequestId: string;
  requestLeaseId: string;
  views: InteractionView[];
  state: 'open' | 'resolved' | 'interrupted';
  resolution?: InteractionResolution;
  interruption?: InteractionInterruption;
  delivery: InteractionDelivery;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateInteractionResult {
  interaction: InteractionRecord;
  created: boolean;
}