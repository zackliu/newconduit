import { DefaultAzureCredential } from '@azure/identity';
import { WebPubSubServiceClient } from '@azure/web-pubsub';
import { WebPubSubClient } from '@azure/web-pubsub-client';
import type { OnGroupDataMessageArgs } from '@azure/web-pubsub-client';
import type { PrincipalContext, RequestContext, RuntimeChannel, RuntimeConnectionGrant, RuntimeEvent, RuntimeEventHandler, RuntimeEventTransport, RuntimeSubscription, TenantConnectionIssuer } from '../../shared';

export interface WebPubSubTransportAdapterOptions {
  tenantId: string;
  endpoint: string;
  hubName: string;
}

export class WebPubSubTransportAdapter implements RuntimeEventTransport, TenantConnectionIssuer {
  private readonly serviceClient: WebPubSubServiceClient;
  private readonly handlers = new Map<string, RuntimeEventHandler[]>();

  private client: WebPubSubClient | undefined;

  constructor(private readonly options: WebPubSubTransportAdapterOptions) {
    if (!options.tenantId) {
      throw new Error('tenantId is required for Web PubSub transport group mapping');
    }
    this.serviceClient = new WebPubSubServiceClient(options.endpoint, new DefaultAzureCredential(), options.hubName);
  }

  async publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void> {
    const client = await this.ensureClient();
    const group = this.toGroup(channel);
    await client.sendToGroup(group, event, 'json');
  }

  async subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription> {
    const group = this.toGroup(channel);
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
    const groups = channels.map((channel) => this.toGroup(channel));
    const roles = groups.flatMap((group) => [`webpubsub.joinLeaveGroup.${group}`, `webpubsub.sendToGroup.${group}`]);
    const token = await this.serviceClient.getClientAccessToken({
      userId: this.toUserId(principal),
      groups,
      roles
    });
    return { url: token.url };
  }

  stop(): void {
    this.client?.stop();
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

  private toGroup(channel: RuntimeChannel): string {
    const tenantPrefix = `tenant:${this.toGroupSegment(this.options.tenantId)}`;
    switch (channel.kind) {
      case 'tenant-inbox':
        return `${tenantPrefix}:central:events`;
      case 'session-events':
        return `${tenantPrefix}:session:${this.toGroupSegment(channel.sessionId)}`;
      case 'worker-commands':
        return `${tenantPrefix}:worker:${this.toGroupSegment(channel.workerId)}`;
    }
  }

  private toGroupSegment(value: string): string {
    if (!value) {
      throw new Error('Web PubSub group segment cannot be empty');
    }
    return encodeURIComponent(value);
  }

  private toUserId(principal: PrincipalContext): string {
    return `${principal.type}:${encodeURIComponent(principal.principalId)}`;
  }

  private contextFromGroupMessage(args: OnGroupDataMessageArgs): RequestContext {
    return {
      principal: this.principalFromUserId(args.message.fromUserId)
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
    return {
      principalId: decodeURIComponent(userId.slice(separatorIndex + 1)),
      type
    };
  }
}