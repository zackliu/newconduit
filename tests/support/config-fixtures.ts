import { FileConfigStore } from '../../src/central/config/file-config-store';
import type { AgentSpec } from '../../src/shared';

/**
 * Scenario tests read their AgentSpec fixture from the same config directory the runtime loads at startup,
 * so tests exercise the real config source instead of a source-embedded constant.
 */
const agentSpecs = new FileConfigStore().loadAgentSpecs();

function requireAgentSpec(agentSpecId: string): AgentSpec {
  const spec = agentSpecs.find((candidate) => candidate.agentSpecId === agentSpecId);
  if (!spec) {
    throw new Error(`config fixture is missing agentSpec ${agentSpecId}`);
  }
  return spec;
}

export const POC_AGENT_SPEC: AgentSpec = requireAgentSpec('copilot-poc');
export const LOCAL_AGENT_SPEC: AgentSpec = requireAgentSpec('copilot-local');

/**
 * Worker matching is pure labels. A worker self-reports the pool template labels (which include the storage
 * capability label) and is backed by a storage driver whose classId is the worker's `storageClass`. These
 * fixtures come from the real config so tests exercise the same values the runtime loads.
 */
export const COPILOT_WORKER_LABELS: Record<string, string> = POC_AGENT_SPEC.workerSelector.matchLabels;
export const COPILOT_STORAGE_CLASS: string = POC_AGENT_SPEC.workerSelector.matchLabels.storage;
export const LOCAL_WORKER_LABELS: Record<string, string> = LOCAL_AGENT_SPEC.workerSelector.matchLabels;
export const LOCAL_STORAGE_CLASS: string = LOCAL_AGENT_SPEC.workerSelector.matchLabels.storage;
