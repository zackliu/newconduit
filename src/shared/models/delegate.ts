/**
 * How a delegate's tool call selects its target worker. This is a trusted, config-declared routing policy — a caller
 * cannot widen it from the tool payload.
 * - `pool` (default): a stateless task placed by ordinary least-loaded routing within the callee AgentSpec's base
 *   worker selector. An absent target or `{ scope: 'any' }` is allowed.
 * - `device`: an on-device task that MUST name an explicit case-roster target (`{ deviceRef }`, `{ deviceRefs }`, or
 *   `{ scope: 'all' }`). An absent target or `{ scope: 'any' }` is rejected rather than silently sent to the pool, so
 *   a device-specific diagnostic can never route to an unrelated worker.
 */
export type DelegateTargetPolicy = 'pool' | 'device';

export interface Delegate {
  id: string;
  toolName: string;
  description: string;
  maxInputBytes: number;
  maxResultBytes: number;
  deadlineMs: number;
  maxQueuedCalls: number;
  /** Target-selection policy; defaults to `pool` when omitted. */
  targetPolicy?: DelegateTargetPolicy;
}