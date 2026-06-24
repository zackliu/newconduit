import { createHash } from 'node:crypto';
import type { Clock, AgentSpec, ResolvedAgentSpec } from '../../shared';

export class AgentSpecAdmissionController {
  constructor(private readonly clock: Clock) {}

  resolve(spec: AgentSpec): ResolvedAgentSpec {
    return {
      ...spec,
      resolvedAt: this.clock.now(),
      digest: createHash('sha256').update(JSON.stringify(spec)).digest('hex')
    };
  }
}