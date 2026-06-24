import { WebPubSubClient } from '@azure/web-pubsub-client';
import { WebPubSubRuntimeChannelMapper, type RuntimeChannel, type RuntimeEvent } from '../../shared';
import type { SidecarRuntimeTransport } from '../contracts';

export interface WebPubSubClientAdapterOptions {
  tenantId: string;
}

export class WebPubSubClientAdapter implements SidecarRuntimeTransport {
  private readonly channelMapper: WebPubSubRuntimeChannelMapper;
  private client: WebPubSubClient | undefined;

  constructor(options: WebPubSubClientAdapterOptions) {
    this.channelMapper = new WebPubSubRuntimeChannelMapper(options.tenantId);
  }

  async connect(accessUrl: string): Promise<void> {
    if (!accessUrl) {
      throw new Error('accessUrl is required');
    }
    const client = new WebPubSubClient(accessUrl, {
      autoReconnect: false,
      autoRejoinGroups: false
    });
    await client.start();
    this.client = client;
  }

  async publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void> {
    if (!this.client) {
      throw new Error('sidecar Web PubSub client is not connected');
    }
    await this.client.sendToGroup(this.channelMapper.toGroup(channel), event, 'json');
  }

  stop(): void {
    this.client?.stop();
    this.client = undefined;
  }

}