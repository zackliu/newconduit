import type { AgentSpec } from '../../shared';

export const POC_AGENT_SPEC: AgentSpec = {
  agentSpecId: 'copilot-poc',
  labels: {
    agent: 'copilot',
    tier: 'poc'
  },
  launch: {
    command: 'copilot',
    args: []
  },
  sidecarClass: 'copilot-process-wrapper',
  workspaceClass: 'docker-workspace-volume-snapshot',
  toolProfile: 'copilot-poc-tools',
  workerSelector: {
    matchLabels: {
      agent: 'copilot'
    }
  },
  pausePolicy: 'turn-boundary-durable-pause',
  recoveryPolicy: 'restart-with-context',
  agentStatePolicy: 'copilot-session-volume-snapshot',
  version: 'poc-v1'
};