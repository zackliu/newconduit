import type { RequestContext, RuntimeEvent, RuntimeEventTransport } from '../../shared';
import { AgentRuntimeEventController } from './agent-runtime-event-controller';
import { ClientRuntimeEventController } from './client-runtime-event-controller';
import { WorkerRuntimeEventController } from './worker-runtime-event-controller';

/**
 * Owns the tenant inbox demultiplexing point where all external runtime messages first cross into tenant-owned control flow.
 */
export class TenantInboxController {
  constructor(
    private readonly tenantId: string,
    private readonly workerRuntimeEventController: WorkerRuntimeEventController,
    private readonly agentRuntimeEventController: AgentRuntimeEventController,
    private readonly clientRuntimeEventController: ClientRuntimeEventController,
    private readonly eventTransport: RuntimeEventTransport
  ) {}

  async handleRuntimeEvent(context: RequestContext, event: RuntimeEvent): Promise<void> {
    const workerOutcome = await this.workerRuntimeEventController.handleRuntimeEvent(this.tenantId, event);
    if (workerOutcome.handled) {
      return;
    }
    if (await this.agentRuntimeEventController.handleRuntimeEvent(event)) {
      return;
    }
    await this.clientRuntimeEventController.handleRuntimeEvent(context, event);
  }

  async reconcileSessions(): Promise<void> {
    await this.workerRuntimeEventController.reconcileSessions();
  }
}