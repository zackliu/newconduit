import type { RuntimeEvent } from '../../shared';

export class WebPubSubClientAdapter {
  async connect(accessUrl: string): Promise<void> {
    if (!accessUrl) {
      throw new Error('accessUrl is required');
    }
  }

  async publish(_group: string, _event: RuntimeEvent): Promise<void> {
    return;
  }
}