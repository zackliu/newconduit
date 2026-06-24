import type { RuntimeChannel } from '../contracts';

export class WebPubSubRuntimeChannelMapper {
  constructor(private readonly tenantId: string) {
    if (!tenantId) {
      throw new Error('tenantId is required for Web PubSub runtime channel mapping');
    }
  }

  toGroup(channel: RuntimeChannel): string {
    const tenantPrefix = `tenant:${this.toGroupSegment(this.tenantId)}`;
    switch (channel.kind) {
      case 'tenant-inbox':
        return `${tenantPrefix}:central:events`;
      case 'session-events':
        return `${tenantPrefix}:session:${this.toGroupSegment(channel.sessionId)}`;
      case 'worker-commands':
        return `${tenantPrefix}:worker:${this.toGroupSegment(channel.workerId)}`;
    }
  }

  toGroupSegment(value: string): string {
    if (!value) {
      throw new Error('Web PubSub group segment cannot be empty');
    }
    return encodeURIComponent(value);
  }
}