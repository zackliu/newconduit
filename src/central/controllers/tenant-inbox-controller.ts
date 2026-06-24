import type { RequestContext, RuntimeEvent } from '../../shared';
import { ClientRuntimeEventController } from './client-runtime-event-controller';
import { WorkerRuntimeEventController } from './worker-runtime-event-controller';

export class TenantInboxController {
  constructor(
    private readonly tenantId: string,
    private readonly workerRuntimeEventController: WorkerRuntimeEventController,
    private readonly clientRuntimeEventController: ClientRuntimeEventController
  ) {}

  async handleRuntimeEvent(context: RequestContext, event: RuntimeEvent): Promise<void> {
    if (await this.workerRuntimeEventController.handleRuntimeEvent(this.tenantId, event)) {
      return;
    }
    await this.clientRuntimeEventController.handleRuntimeEvent(context, event);
  }
}