import type { RequestContext, RuntimeEvent, RuntimeEventTransport } from '../../shared';
import { AgentRuntimeEventController } from './agent-runtime-event-controller';
import { ClientRuntimeEventController } from './client-runtime-event-controller';
import { DelegationRuntimeEventController } from './delegation-runtime-event-controller';
import { WorkerRuntimeEventController } from './worker-runtime-event-controller';

/**
 * Owns the tenant inbox demultiplexing point where all external runtime messages first cross into tenant-owned control flow.
 */
export class TenantInboxController {
  constructor(
    private readonly tenantId: string,
    private readonly workerRuntimeEventController: WorkerRuntimeEventController,
    private readonly agentRuntimeEventController: AgentRuntimeEventController,
    private readonly delegationRuntimeEventController: DelegationRuntimeEventController | undefined,
    private readonly clientRuntimeEventController: ClientRuntimeEventController,
    private readonly eventTransport: RuntimeEventTransport
  ) {}

  async handleRuntimeEvent(context: RequestContext, event: RuntimeEvent): Promise<void> {
    try {
      const workerOutcome = await this.workerRuntimeEventController.handleRuntimeEvent(context, event);
      if (workerOutcome.handled) {
        return;
      }
      if (await this.delegationRuntimeEventController?.handleRuntimeEvent(event)) {
        return;
      }
      if (await this.agentRuntimeEventController.handleRuntimeEvent(event)) {
        await this.delegationRuntimeEventController?.observeAgentEvent(event);
        return;
      }
      await this.clientRuntimeEventController.handleRuntimeEvent(context, event);
    } catch (error) {
      // A single malformed or rejected ingress event must not tear down the tenant inbox subscription.
      console.error(`tenant ${this.tenantId} dropped runtime event ${event.type} (${event.eventId})`, error);
    }
  }

  async reconcileSessions(): Promise<void> {
    await this.workerRuntimeEventController.reconcileSessions();
    await this.delegationRuntimeEventController?.reconcilePendingAwaitResponses();
  }
}