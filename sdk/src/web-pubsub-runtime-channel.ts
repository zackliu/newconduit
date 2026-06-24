export type SdkRuntimeChannel =
  | { kind: 'tenant-inbox' }
  | { kind: 'client-inbox'; principalId: string }
  | { kind: 'session-events'; sessionId: string };

export class SdkWebPubSubRuntimeChannelMapper {
  constructor(private readonly tenantId: string) {
    if (!tenantId) {
      throw new Error('tenantId is required for SDK Web PubSub runtime channel mapping');
    }
  }

  toGroup(channel: SdkRuntimeChannel): string {
    const tenantPrefix = `tenant:${this.toGroupSegment(this.tenantId)}`;
    switch (channel.kind) {
      case 'tenant-inbox':
        return `${tenantPrefix}:central:events`;
      case 'client-inbox':
        return `${tenantPrefix}:client:${this.toGroupSegment(channel.principalId)}:events`;
      case 'session-events':
        return `${tenantPrefix}:session:${this.toGroupSegment(channel.sessionId)}`;
    }
  }

  private toGroupSegment(value: string): string {
    if (!value) {
      throw new Error('SDK Web PubSub group segment cannot be empty');
    }
    return encodeURIComponent(value);
  }
}