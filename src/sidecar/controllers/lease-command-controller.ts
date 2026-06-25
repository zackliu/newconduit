import type { RuntimeEvent } from '../../shared';

/**
 * Tracks the session lease accepted by the sidecar so worker commands are scoped to the assignment central issued.
 */
export class LeaseCommandController {
  private sessionLeaseId: string | undefined;

  acceptAssign(event: RuntimeEvent): void {
    if (event.type !== 'session.assign') {
      throw new Error(`unexpected sidecar command: ${event.type}`);
    }
    this.sessionLeaseId = event.sessionLeaseId;
  }

  currentSessionLeaseId(): string | undefined {
    return this.sessionLeaseId;
  }
}