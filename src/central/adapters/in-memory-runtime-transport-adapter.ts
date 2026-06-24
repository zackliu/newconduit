import type { PrincipalContext, RequestContext, RuntimeChannel, RuntimeConnectionGrant, RuntimeEvent, RuntimeEventHandler, RuntimeEventTransport, RuntimeSubscription, TenantConnectionIssuer } from '../../shared';

export class InMemoryRuntimeTransportAdapter implements RuntimeEventTransport, TenantConnectionIssuer {
  private readonly handlers = new Map<string, RuntimeEventHandler[]>();

  async publish(channel: RuntimeChannel, event: RuntimeEvent, context?: RequestContext): Promise<void> {
    await Promise.all((this.handlers.get(this.channelKey(channel)) ?? []).map((handler) => handler({
      event,
      context: context ?? this.contextFromEvent(event)
    })));
  }

  async subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription> {
    const key = this.channelKey(channel);
    this.handlers.set(key, [...(this.handlers.get(key) ?? []), handler]);
    return {
      close: async () => {
        this.handlers.set(key, (this.handlers.get(key) ?? []).filter((candidate) => candidate !== handler));
      }
    };
  }

  async issueClientConnection(input: { principal: PrincipalContext; channels: RuntimeChannel[] }): Promise<RuntimeConnectionGrant> {
    return this.issueConnection(input.principal, input.channels);
  }

  async issueSidecarConnection(input: { principal: PrincipalContext; channels: RuntimeChannel[] }): Promise<RuntimeConnectionGrant> {
    return this.issueConnection(input.principal, input.channels);
  }

  private issueConnection(principal: PrincipalContext, channels: RuntimeChannel[]): RuntimeConnectionGrant {
    return { url: `memory://poc?principal=${encodeURIComponent(principal.principalId)}&channels=${encodeURIComponent(channels.map((channel) => this.channelKey(channel)).join(','))}` };
  }

  private contextFromEvent(event: RuntimeEvent): RequestContext {
    return {
      principal: {
        principalId: event.actor,
        type: event.actor === 'sidecar' ? 'service' : 'user'
      }
    };
  }

  private channelKey(channel: RuntimeChannel): string {
    switch (channel.kind) {
      case 'tenant-inbox':
        return 'tenant-inbox';
      case 'client-inbox':
        return `client-inbox:${channel.principalId}`;
      case 'session-events':
        return `session-events:${channel.sessionId}`;
      case 'worker-commands':
        return `worker-commands:${channel.workerId}`;
    }
  }
}