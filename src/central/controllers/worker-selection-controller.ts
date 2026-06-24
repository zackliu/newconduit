import type { LabelSelector, SessionRecord, WorkerRecord } from '../../shared';

export class WorkerSelectionController {
  select(session: SessionRecord, workers: WorkerRecord[]): WorkerRecord | undefined {
    return workers.find((worker) =>
      worker.sidecarClass === session.resolvedAgentSpec.sidecarClass
      && worker.lifecycleState === 'active'
      && worker.allocatable > 0
      && worker.conditions.includes('ready')
      && this.matchesSelector(worker.labels, session.resolvedAgentSpec.workerSelector)
    );
  }

  private matchesSelector(labels: Record<string, string>, selector: LabelSelector): boolean {
    return Object.entries(selector.matchLabels).every(([key, value]) => labels[key] === value);
  }
}