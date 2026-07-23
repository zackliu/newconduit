import type { RequestContext, RuntimeEvent, RuntimeEventTransport } from '../../shared';
import { AgentRuntimeEventController } from './agent-runtime-event-controller';
import { ClientRuntimeEventController } from './client-runtime-event-controller';
import { DelegationRuntimeEventController } from './delegation-runtime-event-controller';
import { WorkerRuntimeEventController } from './worker-runtime-event-controller';
import type { InteractionManager } from '../managers';

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
    private readonly interactionManager: InteractionManager,
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
      const agentOutcome = await this.agentRuntimeEventController.handleRuntimeEvent(event);
      if (agentOutcome.handled) {
        // Projection is deliberately re-driven for duplicate event ids. The session event append, cursor update,
        // delegation projection, and worker acknowledgement are separate durable steps; replay must repair a crash
        // between any two of them. Delegation projection is idempotent and acknowledgement happens only after it.
        await this.delegationRuntimeEventController?.observeAgentEvent(event);
        await this.agentRuntimeEventController.acknowledgeWorkerResultIfNeeded(event);
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
    await this.interactionManager.reconcile();
  }
}