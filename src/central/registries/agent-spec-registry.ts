import type { AgentSpec, AgentSpecRef } from '../../shared';

export interface AgentSpecRegistry {
  resolve(ref: AgentSpecRef): Promise<AgentSpec>;
  list(): AgentSpec[];
}

export class StaticAgentSpecRegistry implements AgentSpecRegistry {
  private readonly agentSpecsById: ReadonlyMap<string, AgentSpec>;

  constructor(agentSpecs: AgentSpec[]) {
    this.agentSpecsById = new Map(agentSpecs.map((agentSpec) => [agentSpec.agentSpecId, agentSpec]));
  }

  async resolve(ref: AgentSpecRef): Promise<AgentSpec> {
    const agentSpec = this.agentSpecsById.get(ref.agentSpecId);
    if (!agentSpec) {
      throw new Error(`unknown agentSpecId: ${ref.agentSpecId}`);
    }
    return agentSpec;
  }

  list(): AgentSpec[] {
    return [...this.agentSpecsById.values()];
  }
}