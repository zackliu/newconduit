export type RuntimeEventType =
  | 'session.create.requested'
  | 'session.created'
  | 'session.assign'
  | 'input.received'
  | 'input.accepted'
  | 'agent.output'
  | 'session.pause.requested'
  | 'snapshot.created'
  | 'session.paused'
  | 'session.resume.requested'
  | 'session.resumed'
  | 'session.cancel.requested'
  | 'session.cancelled'
  | 'worker.register'
  | 'worker.registered'
  | 'worker.heartbeat'
  | 'worker.drain.requested'
  | 'worker.draining'
  | 'worker.close.requested'
  | 'worker.closed'
  | 'worker.expired'
  | 'worker.heartbeat.rejected'
  | 'worker.lease.lost';

export interface RuntimeEvent<TPayload = unknown> {
  eventId: string;
  sessionId?: string;
  workerId?: string;
  ackId?: string;
  turnSeq?: number;
  sequence: number;
  type: RuntimeEventType;
  timestamp: string;
  actor: 'client' | 'central' | 'sidecar' | 'system';
  workerLeaseGeneration?: number;
  payload: TPayload;
}

export interface SessionAssignPayload {
  sessionId: string;
  workerId: string;
  workerLeaseGeneration: number;
  workspaceRef: string;
  resolvedAgentSpec: {
    agentSpecId: string;
    sidecarClass: string;
    digest: string;
  };
}