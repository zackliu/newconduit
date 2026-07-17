import type { AgentRuntimeToolDefinition } from './runtime-tool';

export interface LabelSelector {
  matchLabels: Record<string, string>;
}

export interface AgentSpecDelegateRefs {
  asCaller: string[];
  asCallee: string[];
}

export interface AgentSpec {
  agentSpecId: string;
  labels: Record<string, string>;
  launch: {
    command: string;
    args: string[];
  };
  instructions: string;
  toolProfile: string;
  delegateRefs: AgentSpecDelegateRefs;
  workerSelector: LabelSelector;
  pausePolicy: string;
  recoveryPolicy: string;
  idlePauseTimeoutMs: number;
  version: string;
}

export interface ResolvedAgentSpec extends AgentSpec {
  runtimeTools: AgentRuntimeToolDefinition[];
  resolvedAt: string;
  digest: string;
}