import type { JsonValue } from './delegation';

export interface AgentRuntimeToolDefinition {
  name: string;
  description: string;
  inputSchema: { [key: string]: JsonValue };
  binding: {
    kind: 'delegate';
    delegateId: string;
  };
}