import { createHash } from 'node:crypto';
import type { AgentRuntimeToolDefinition, AgentSpec, Clock, ResolvedAgentSpec } from '../../../shared';

type RuntimeToolResolver = (spec: AgentSpec) => AgentRuntimeToolDefinition[];

/**
 * Freezes an AgentSpec into the resolved runtime contract a session will carry through assignment and recovery.
 */
export class AgentSpecAdmissionManager {
  constructor(
    private readonly clock: Clock,
    private readonly resolveRuntimeTools: RuntimeToolResolver = () => []
  ) {}

  resolve(spec: AgentSpec): ResolvedAgentSpec {
    const runtimeTools = this.resolveRuntimeTools(spec);
    return {
      ...spec,
      runtimeTools,
      resolvedAt: this.clock.now(),
      digest: createHash('sha256').update(JSON.stringify({ spec, runtimeTools })).digest('hex')
    };
  }
}