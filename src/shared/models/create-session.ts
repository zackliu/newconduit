export interface AgentSpecRef {
  agentSpecId: string;
  version?: string;
}

export interface CreateSessionRequest {
  agent: AgentSpecRef;
  input: {
    initialMessage: string;
    clientRequestId: string;
  };
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
}

export interface RequestContext {
  principal: PrincipalContext;
  connectionId?: string;
}

export interface TenantContext {
  tenantId: string;
  storageRoot: string;
  webPubSubHub: string;
}