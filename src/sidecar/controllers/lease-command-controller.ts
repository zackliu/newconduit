import type { RuntimeEvent } from '../../shared';

export class LeaseCommandController {
  private generation = 0;

  acceptAssign(event: RuntimeEvent): void {
    if (event.type !== 'session.assign') {
      throw new Error(`unexpected sidecar command: ${event.type}`);
    }
    this.generation = event.workerLeaseGeneration ?? 0;
  }

  currentGeneration(): number {
    return this.generation;
  }
}