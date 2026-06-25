import { WebPubSubClient } from '@azure/web-pubsub-client';
import { WebPubSubRuntimeChannelMapper, type RuntimeChannel, type RuntimeEvent, type RuntimeEventHandler, type RuntimeSubscription } from '../../shared';
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

  async subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription> {
    if (!this.client) {
      throw new Error('sidecar Web PubSub client is not connected');
    }
    const group = this.channelMapper.toGroup(channel);
    const listener = (message: { message: { group: string; data: unknown } }): void => {
      if (message.message.group !== group) {
        return;
      }
      const event = this.parseEvent(message.message.data);
      void handler({
        event,
        context: {
          principal: {
            principalId: 'sidecar',
            type: 'service'
          }
        }
      }).catch((error: unknown) => {
        console.error('sidecar runtime event handler failed', error);
      });
    };
    this.client.on('group-message', listener);
    await this.client.joinGroup(group);
    return {
      close: async () => {
        this.client?.off('group-message', listener);
      }
    };
  }

  async stop(): Promise<void> {
    await stopWebPubSubClient(this.client);
    this.client = undefined;
  }

  private parseEvent(data: unknown): RuntimeEvent {
    if (this.isEvent(data)) {
      return data;
    }
    if (typeof data === 'string') {
      const parsed = JSON.parse(data) as unknown;
      if (this.isEvent(parsed)) {
        return parsed;
      }
    }
    throw new Error('received invalid sidecar runtime event');
  }

  private isEvent(data: unknown): data is RuntimeEvent {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const candidate = data as Partial<RuntimeEvent>;
    return typeof candidate.eventId === 'string'
      && typeof candidate.sequence === 'number'
      && typeof candidate.type === 'string'
      && typeof candidate.timestamp === 'string'
      && typeof candidate.actor === 'string'
      && 'payload' in candidate;
  }
}

async function stopWebPubSubClient(client: WebPubSubClient | undefined): Promise<void> {
  client?.stop();
}