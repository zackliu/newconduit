import { DelegateAdmissionManager } from '../managers';
import { StaticAgentSpecRegistry, type AgentSpecRegistry } from '../registries/agent-spec-registry';
import { StaticDelegateBindingIndex, StaticDelegateRegistry, StaticResolvedDelegateRegistry, type DelegateBindingIndex, type ResolvedDelegateRegistry } from '../registries/delegate-registry';
import { FileConfigStore } from './file-config-store';

export interface TenantConfigGeneration {
  agentSpecRegistry: AgentSpecRegistry;
  delegation: {
    resolvedDelegateRegistry: ResolvedDelegateRegistry;
    delegateBindingIndex: DelegateBindingIndex;
    delegateAdmissionManager: DelegateAdmissionManager;
  };
}

export function loadTenantConfigGeneration(store: FileConfigStore = new FileConfigStore()): TenantConfigGeneration {
  const agentSpecs = store.loadAgentSpecs();
  const delegates = store.loadDelegates();
  const rawDelegateRegistry = new StaticDelegateRegistry(delegates);
  const delegateAdmissionManager = new DelegateAdmissionManager();
  return {
    agentSpecRegistry: new StaticAgentSpecRegistry(agentSpecs),
    delegation: {
      resolvedDelegateRegistry: new StaticResolvedDelegateRegistry({
        delegates,
        admissionManager: delegateAdmissionManager
      }),
      delegateBindingIndex: new StaticDelegateBindingIndex(rawDelegateRegistry, agentSpecs),
      delegateAdmissionManager
    }
  };
}