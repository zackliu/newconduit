import { COPILOT_LOCAL_PROCESS_SIDECAR_CLASS, COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, type AgentSpec } from '../../shared';

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
  sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
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
  idlePauseTimeoutMs: 120_000,
  version: 'poc-v1'
};

export const POC_LOCAL_AGENT_SPEC: AgentSpec = {
  agentSpecId: 'copilot-local',
  labels: {
    agent: 'local',
    tier: 'poc'
  },
  launch: {
    command: 'copilot',
    args: []
  },
  sidecarClass: COPILOT_LOCAL_PROCESS_SIDECAR_CLASS,
  workspaceClass: 'local-managed',
  toolProfile: 'copilot-poc-tools',
  workerSelector: {
    matchLabels: {
      agent: 'local'
    }
  },
  pausePolicy: 'stop-on-pause',
  recoveryPolicy: 'restart-with-context',
  agentStatePolicy: 'copilot-managed-local',
  idlePauseTimeoutMs: 120_000,
  version: 'poc-v1'
};