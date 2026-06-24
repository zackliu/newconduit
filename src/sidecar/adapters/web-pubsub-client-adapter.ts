import type { RuntimeChannel, RuntimeEvent } from '../../shared';

export class WebPubSubClientAdapter {
  async connect(accessUrl: string): Promise<void> {
    if (!accessUrl) {
      throw new Error('accessUrl is required');
    }
  }

  async publish(_channel: RuntimeChannel, _event: RuntimeEvent): Promise<void> {
    return;
  }
}