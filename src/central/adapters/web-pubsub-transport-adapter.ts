import { DefaultAzureCredential } from '@azure/identity';
import { WebPubSubServiceClient } from '@azure/web-pubsub';
import { WebPubSubClient } from '@azure/web-pubsub-client';
import type { OnGroupDataMessageArgs } from '@azure/web-pubsub-client';
import { WebPubSubRuntimeChannelMapper, type PrincipalContext, type RequestContext, type RuntimeChannel, type RuntimeConnectionGrant, type RuntimeEvent, type RuntimeEventHandler, type RuntimeEventTransport, type RuntimeSubscription, type TenantConnectionIssuer } from '../../shared';

export interface WebPubSubTransportAdapterOptions {
  tenantId: string;
  endpoint: string;
  hubName: string;
}

export class WebPubSubTransportAdapter implements RuntimeEventTransport, TenantConnectionIssuer {
  private readonly serviceClient: WebPubSubServiceClient;
  private readonly channelMapper: WebPubSubRuntimeChannelMapper;
  private readonly handlers = new Map<string, RuntimeEventHandler[]>();

  private client: WebPubSubClient | undefined;

  constructor(private readonly options: WebPubSubTransportAdapterOptions) {
    this.channelMapper = new WebPubSubRuntimeChannelMapper(options.tenantId);
    this.serviceClient = new WebPubSubServiceClient(options.endpoint, new DefaultAzureCredential(), options.hubName);
  }

  async publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void> {
    const client = await this.ensureClient();
    const group = this.channelMapper.toGroup(channel);
    await client.sendToGroup(group, event, 'json');
  }

  async subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription> {
    const group = this.channelMapper.toGroup(channel);
    this.handlers.set(group, [...(this.handlers.get(group) ?? []), handler]);
    const client = await this.ensureClient();
    await client.joinGroup(group);
    return {
      close: async () => {
        this.handlers.set(group, (this.handlers.get(group) ?? []).filter((candidate) => candidate !== handler));
      }
    };
  }

  async issueClientConnection(input: { principal: PrincipalContext; channels: RuntimeChannel[] }): Promise<RuntimeConnectionGrant> {
    return this.issueConnection(input.principal, input.channels);
  }

  async issueSidecarConnection(input: { principal: PrincipalContext; channels: RuntimeChannel[] }): Promise<RuntimeConnectionGrant> {
    return this.issueConnection(input.principal, input.channels);
  }

  private async issueConnection(principal: PrincipalContext, channels: RuntimeChannel[]): Promise<RuntimeConnectionGrant> {
    const groups = channels.map((channel) => this.channelMapper.toGroup(channel));
    const roles = ['webpubsub.joinLeaveGroup', ...groups.flatMap((group) => [`webpubsub.joinLeaveGroup.${group}`, `webpubsub.sendToGroup.${group}`])];
    const token = await this.serviceClient.getClientAccessToken({
      userId: this.toUserId(principal),
      groups,
      roles
    });
    return { url: token.url };
  }

  async stop(): Promise<void> {
    await stopWebPubSubClient(this.client);
    this.client = undefined;
  }

  private async ensureClient(): Promise<WebPubSubClient> {
    if (this.client) {
      return this.client;
    }

    const token = await this.serviceClient.getClientAccessToken({
      userId: 'central-runtime',
      roles: ['webpubsub.joinLeaveGroup', 'webpubsub.sendToGroup']
    });
    const client = new WebPubSubClient(token.url, {
      autoReconnect: false,
      autoRejoinGroups: false
    });
    client.on('group-message', (message) => {
      void this.dispatchGroupMessage(message);
    });
    await client.start();
    this.client = client;
    return client;
  }

  private async dispatchGroupMessage(args: OnGroupDataMessageArgs): Promise<void> {
    const event = this.parseRuntimeEvent(args.message.data);
    const context = this.contextFromGroupMessage(args);
    await Promise.all((this.handlers.get(args.message.group) ?? []).map((handler) => handler({ event, context })));
  }

  private parseRuntimeEvent(data: unknown): RuntimeEvent {
    if (this.isRuntimeEvent(data)) {
      return data;
    }
    if (typeof data === 'string') {
      const parsed = JSON.parse(data) as unknown;
      if (this.isRuntimeEvent(parsed)) {
        return parsed;
      }
    }
    throw new Error('received invalid runtime event from Web PubSub group message');
  }

  private isRuntimeEvent(value: unknown): value is RuntimeEvent {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const candidate = value as Partial<RuntimeEvent>;
    return typeof candidate.eventId === 'string'
      && typeof candidate.sequence === 'number'
      && typeof candidate.type === 'string'
      && typeof candidate.timestamp === 'string'
      && typeof candidate.actor === 'string'
      && 'payload' in candidate;
  }

  private toUserId(principal: PrincipalContext): string {
    const encodedPrincipal = `${principal.type}:${encodeURIComponent(principal.principalId)}`;
    return principal.connectionId ? `${encodedPrincipal}:connection:${encodeURIComponent(principal.connectionId)}` : encodedPrincipal;
  }

  private contextFromGroupMessage(args: OnGroupDataMessageArgs): RequestContext {
    const principal = this.principalFromUserId(args.message.fromUserId);
    return {
      principal,
      connectionId: principal.connectionId
    };
  }

  private principalFromUserId(userId: string): PrincipalContext {
    const separatorIndex = userId.indexOf(':');
    if (separatorIndex < 0) {
      return { principalId: userId, type: 'user' };
    }
    const type = userId.slice(0, separatorIndex);
    if (type !== 'user' && type !== 'service') {
      return { principalId: userId, type: 'user' };
    }
    const rest = userId.slice(separatorIndex + 1);
    const connectionMarker = ':connection:';
    const connectionIndex = rest.indexOf(connectionMarker);
    if (connectionIndex < 0) {
      return {
        principalId: decodeURIComponent(rest),
        type
      };
    }
    return {
      principalId: decodeURIComponent(rest.slice(0, connectionIndex)),
      type,
      connectionId: decodeURIComponent(rest.slice(connectionIndex + connectionMarker.length))
    };
  }
}

async function stopWebPubSubClient(client: WebPubSubClient | undefined): Promise<void> {
  client?.stop();
}