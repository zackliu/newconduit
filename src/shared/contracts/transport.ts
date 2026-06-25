import type { RuntimeEvent, WorkerRecord } from '../models';
import type { PrincipalContext, RequestContext } from '../models/create-session';

export type RuntimeChannel =
  | { kind: 'tenant-inbox' }
  | { kind: 'client-inbox' }
  | { kind: 'client-private-inbox'; clientConnectionId: string }
  | { kind: 'session-events'; sessionId: string }
  | { kind: 'worker-commands'; workerId: string };

export interface RuntimeEventEnvelope {
  event: RuntimeEvent;
  context: RequestContext;
}

export type RuntimeEventHandler = (envelope: RuntimeEventEnvelope) => Promise<void>;

export interface RuntimeSubscription {
  close(): Promise<void>;
}

export interface RuntimeEventTransport {
  publish(channel: RuntimeChannel, event: RuntimeEvent, context?: RequestContext): Promise<void>;
  subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription>;
}

export interface RuntimeConnectionGrant {
  url: string;
  expiresAt?: string;
  clientInbox?: Record<string, never>;
  clientPrivateInbox?: {
    clientConnectionId: string;
  };
  worker?: WorkerRecord;
}

export interface TenantConnectionIssuer {
  issueClientConnection(input: { principal: PrincipalContext; channels: RuntimeChannel[] }): Promise<RuntimeConnectionGrant>;
  issueSidecarConnection(input: { principal: PrincipalContext; channels: RuntimeChannel[] }): Promise<RuntimeConnectionGrant>;
}