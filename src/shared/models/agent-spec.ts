import type { SidecarClass } from './worker';

export interface LabelSelector {
  matchLabels: Record<string, string>;
}

export interface AgentSpec {
  agentSpecId: string;
  labels: Record<string, string>;
  launch: {
    command: string;
    args: string[];
  };
  sidecarClass: SidecarClass;
  workspaceClass: string;
  toolProfile: string;
  workerSelector: LabelSelector;
  pausePolicy: string;
  recoveryPolicy: string;
  agentStatePolicy: string;
  idlePauseTimeoutMs: number;
  version: string;
}

export interface ResolvedAgentSpec extends AgentSpec {
  resolvedAt: string;
  digest: string;
}