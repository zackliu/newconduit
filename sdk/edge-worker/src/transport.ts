import { WebPubSubClient } from '@azure/web-pubsub-client';
import { EdgeWorkerChannelMapper } from './worker-channel-map.js';
import type { EdgeRuntimeChannel, EdgeRuntimeEvent } from './protocol.js';

export type EdgeRuntimeEventHandler = (event: EdgeRuntimeEvent) => Promise<void> | void;

export interface EdgeWorkerSubscription {
  close(): Promise<void>;
}

export type EdgeTransportConnectionState = 'connected' | 'disconnected';
export type EdgeTransportConnectionListener = (state: EdgeTransportConnectionState) => void;

/**
 * Transport the edge worker uses to reach central over the runtime channel. It is injectable so the
 * runtime can be driven in tests against an in-memory transport, exactly as the Node sidecar daemon
 * injects its own `SidecarRuntimeTransport`.
 */
export interface EdgeWorkerTransport {
  connect(accessUrl: string): Promise<void>;
  publish(channel: EdgeRuntimeChannel, event: EdgeRuntimeEvent): Promise<void>;
  subscribe(channel: EdgeRuntimeChannel, handler: EdgeRuntimeEventHandler): Promise<EdgeWorkerSubscription>;
  stop(): Promise<void>;
  /**
   * Optional: report transport connection transitions so the runtime can flush its durable outbound queue
   * the moment the link is restored. Transports that cannot observe reconnects simply omit this; the
   * runtime still flushes opportunistically on each heartbeat and on turn completion.
   */
  onConnectionStateChanged?(listener: EdgeTransportConnectionListener): void;
}

export interface WebPubSubEdgeWorkerTransportOptions {
  tenantId: string;
}

/**
 * Default browser transport: an Azure Web PubSub client that sends worker results to `tenant-inbox` and
 * receives commands from the worker's own `worker-commands` group. It is a browser-safe peer of the Node
 * sidecar's `WebPubSubClientAdapter`.
 */
export class WebPubSubEdgeWorkerTransport implements EdgeWorkerTransport {
  private readonly channelMapper: EdgeWorkerChannelMapper;
  private client: WebPubSubClient | undefined;
  private readonly connectionListeners = new Set<EdgeTransportConnectionListener>();

  constructor(options: WebPubSubEdgeWorkerTransportOptions) {
    this.channelMapper = new EdgeWorkerChannelMapper(options.tenantId);
  }

  onConnectionStateChanged(listener: EdgeTransportConnectionListener): void {
    this.connectionListeners.add(listener);
  }

  async connect(accessUrl: string): Promise<void> {
    if (!accessUrl) {
      throw new Error('accessUrl is required');
    }
    this.client?.stop();
    this.client = undefined;
    const client = new WebPubSubClient(accessUrl, {
      autoReconnect: true,
      autoRejoinGroups: true,
      reconnectRetryOptions: {
        maxRetries: Number.MAX_VALUE
      }
    });
    client.on('connected', () => this.notifyConnection('connected'));
    client.on('disconnected', () => this.notifyConnection('disconnected'));
    client.on('stopped', () => this.notifyConnection('disconnected'));
    await client.start();
    this.client = client;
  }

  async publish(channel: EdgeRuntimeChannel, event: EdgeRuntimeEvent): Promise<void> {
    if (!this.client) {
      throw new Error('edge worker Web PubSub client is not connected');
    }
    await this.client.sendToGroup(this.channelMapper.toGroup(channel), event, 'json');
  }

  async subscribe(channel: EdgeRuntimeChannel, handler: EdgeRuntimeEventHandler): Promise<EdgeWorkerSubscription> {
    if (!this.client) {
      throw new Error('edge worker Web PubSub client is not connected');
    }
    const group = this.channelMapper.toGroup(channel);
    const listener = (message: { message: { group?: string; data: unknown } }): void => {
      if (message.message.group !== group) {
        return;
      }
      const event = this.parseEvent(message.message.data);
      if (!event) {
        return;
      }
      void Promise.resolve(handler(event)).catch((error: unknown) => {
        console.error('edge worker runtime event handler failed', error);
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
    this.client?.stop();
    this.client = undefined;
  }

  private notifyConnection(state: EdgeTransportConnectionState): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(state);
      } catch (error) {
        console.error('edge worker transport connection listener failed', error);
      }
    }
  }

  private parseEvent(data: unknown): EdgeRuntimeEvent | undefined {
    if (this.isEvent(data)) {
      return data;
    }
    if (typeof data === 'string') {
      const parsed = JSON.parse(data) as unknown;
      if (this.isEvent(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }

  private isEvent(data: unknown): data is EdgeRuntimeEvent {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const candidate = data as Partial<EdgeRuntimeEvent>;
    return typeof candidate.eventId === 'string'
      && typeof candidate.type === 'string'
      && typeof candidate.timestamp === 'string'
      && 'payload' in candidate;
  }
}
