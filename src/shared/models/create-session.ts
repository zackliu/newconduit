export interface AgentSpecRef {
  agentSpecId: string;
  version?: string;
}

export interface CreateSessionRequest {
  agent: AgentSpecRef;
  input?: {
    message: string;
  };
  displayName?: string;
  description?: string;
  externalId?: string;
  workspace: {
    source: 'empty';
  };
  metadata?: {
    labels?: Record<string, string>;
  };
}

export interface PrincipalContext {
  principalId: string;
  type: 'user' | 'service';
  connectionId?: string;
}

export interface RequestContext {
  principal: PrincipalContext;
  connectionId?: string;
}

export interface SessionInputRequest {
  input: {
    message: string;
  };
}

export interface TenantContext {
  tenantId: string;
  storageRoot: string;
  webPubSubHub: string;
}