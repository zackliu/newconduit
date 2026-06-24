import type { RuntimeEvent, RuntimeTransport } from '../../shared';

type Handler = (event: RuntimeEvent) => Promise<void>;

export class WebPubSubTransportAdapter implements RuntimeTransport {
  private readonly handlers = new Map<string, Handler[]>();

  async publish(group: string, event: RuntimeEvent): Promise<void> {
    await Promise.all((this.handlers.get(group) ?? []).map((handler) => handler(event)));
  }

  async subscribe(group: string, handler: Handler): Promise<void> {
    this.handlers.set(group, [...(this.handlers.get(group) ?? []), handler]);
  }

  async negotiate(principal: string, groups: string[]): Promise<{ url: string }> {
    return { url: `webpubsub://poc?principal=${encodeURIComponent(principal)}&groups=${encodeURIComponent(groups.join(','))}` };
  }
}