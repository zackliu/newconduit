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
  sidecarClass: 'copilot-process-wrapper';
  workspaceClass: 'docker-workspace-volume-snapshot';
  toolProfile: 'copilot-poc-tools';
  workerSelector: LabelSelector;
  pausePolicy: 'turn-boundary-durable-pause';
  recoveryPolicy: 'restart-with-context';
  agentStatePolicy: 'copilot-session-volume-snapshot';
  version: string;
}

export interface ResolvedAgentSpec extends AgentSpec {
  resolvedAt: string;
  digest: string;
}