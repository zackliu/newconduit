export interface AuditRecord {
  auditId: string;
  timestamp: string;
  principal: string;
  tenantId: string;
  resourceType: 'AgentSpec' | 'Session' | 'Worker' | 'WorkspaceSnapshot' | 'Event';
  resourceId: string;
  action: string;
  decision: 'allow' | 'deny' | 'record-only';
  reason?: string;
  correlationId?: string;
}