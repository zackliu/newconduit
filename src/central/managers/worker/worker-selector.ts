import type { LabelSelector, SessionRecord, WorkerRecord } from '../../../shared';

/**
 * Chooses a compatible ready worker for a queued session without letting worker source or hosting details leak into assignment.
 */
export class WorkerSelector {
  constructor(private readonly now: () => number = () => Date.now()) {}

  select(session: SessionRecord, workers: WorkerRecord[]): WorkerRecord | undefined {
    const eligible = workers.filter((worker) =>
      worker.lifecycleState === 'active'
      && Date.parse(worker.expiresAt) > this.now()
      && worker.allocatable > 0
      && worker.conditions.includes('ready')
      && this.matchesSelector(worker.labels, session.resolvedAgentSpec.workerSelector)
      && this.matchesRequiredLabels(worker.labels, session.requiredWorkerLabels)
      && this.reuseAllows(worker, session)
    );
    if (eligible.length === 0) {
      return undefined;
    }
    // A session pinned to extra labels (e.g. a delegated scan bound to one paired device) may still match more
    // than one worker when duplicate/reloaded tabs share that label. Resolve it deterministically to the newest
    // registration so a stale prior tab never receives new work; unpinned selection keeps its first-match order.
    if (session.requiredWorkerLabels && Object.keys(session.requiredWorkerLabels).length > 0) {
      return [...eligible].sort((left, right) => this.compareByFreshness(right, left))[0];
    }
    return eligible[0];
  }

  /**
   * A no-reuse worker is bound to a single session identity: only that session may be (re)placed on it, so
   * another session is never selected onto it even when it has free capacity. A reuse (shared) worker accepts
   * any matching session.
   */
  private reuseAllows(worker: WorkerRecord, session: SessionRecord): boolean {
    return worker.reuse !== false || !worker.boundSessionId || worker.boundSessionId === session.sessionId;
  }

  private matchesSelector(labels: Record<string, string>, selector: LabelSelector): boolean {
    return Object.entries(selector.matchLabels).every(([key, value]) => labels[key] === value);
  }

  /**
   * Narrowing-only constraint layered on top of the AgentSpec's base selector. Because both must hold, a caller
   * can only shrink the eligible set within the AgentSpec floor — never widen it or escape to another tenant.
   */
  private matchesRequiredLabels(labels: Record<string, string>, required: Record<string, string> | undefined): boolean {
    if (!required) {
      return true;
    }
    return Object.entries(required).every(([key, value]) => labels[key] === value);
  }

  private compareByFreshness(left: WorkerRecord, right: WorkerRecord): number {
    const leftAt = Date.parse(left.registeredAt ?? left.heartbeatAt);
    const rightAt = Date.parse(right.registeredAt ?? right.heartbeatAt);
    if (leftAt !== rightAt) {
      return leftAt - rightAt;
    }
    return left.workerId.localeCompare(right.workerId);
  }
}