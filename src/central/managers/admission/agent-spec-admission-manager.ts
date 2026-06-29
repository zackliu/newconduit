import { createHash } from 'node:crypto';
import type { AgentSpec, Clock, ResolvedAgentSpec } from '../../../shared';

/**
 * Freezes an AgentSpec into the resolved runtime contract a session will carry through assignment and recovery.
 */
export class AgentSpecAdmissionManager {
  constructor(private readonly clock: Clock) {}

  resolve(spec: AgentSpec): ResolvedAgentSpec {
    return {
      ...spec,
      resolvedAt: this.clock.now(),
      digest: createHash('sha256').update(JSON.stringify(spec)).digest('hex')
    };
  }
}