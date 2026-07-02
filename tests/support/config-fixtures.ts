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
export const COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS = requireAgentSpec('copilot-poc').sidecarClass;
export const COPILOT_LOCAL_PROCESS_SIDECAR_CLASS = requireAgentSpec('copilot-local').sidecarClass;
