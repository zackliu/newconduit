import type { LabelSelector, SessionRecord, WorkerRecord } from '../../../shared';

/**
 * Chooses a compatible ready worker for a queued session without letting worker source or hosting details leak into assignment.
 */
export class WorkerSelector {
  constructor(private readonly now: () => number = () => Date.now()) {}

  select(session: SessionRecord, workers: WorkerRecord[]): WorkerRecord | undefined {
    return workers.find((worker) =>
      worker.lifecycleState === 'active'
      && Date.parse(worker.expiresAt) > this.now()
      && worker.allocatable > 0
      && worker.conditions.includes('ready')
      && this.matchesSelector(worker.labels, session.resolvedAgentSpec.workerSelector)
      && this.reuseAllows(worker, session)
    );
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
}