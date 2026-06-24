export type RuntimeEventType =
  | 'session.create.requested'
  | 'session.created'
  | 'session.assign'
  | 'input.received'
  | 'agent.output'
  | 'session.pause.requested'
  | 'snapshot.created'
  | 'session.paused'
  | 'session.resume.requested'
  | 'session.resumed'
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
  sequence: number;
  type: RuntimeEventType;
  timestamp: string;
  actor: 'client' | 'central' | 'sidecar' | 'system';
  correlationId?: string;
  workerLeaseGeneration?: number;
  payload: TPayload;
}