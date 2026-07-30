import type { EdgeRuntimeChannel } from './protocol.js';

/**
 * Maps an edge worker runtime channel to its Azure Web PubSub group name. The produced strings MUST be
 * identical to the central runtime's `WebPubSubRuntimeChannelMapper` in `src/shared/protocol`, because
 * central publishes worker commands to `tenant:<tid>:worker:<wid>` and consumes worker results from
 * `tenant:<tid>:central:events`.
 */
export class EdgeWorkerChannelMapper {
  constructor(private readonly tenantId: string) {
    if (!tenantId) {
      throw new Error('tenantId is required for edge worker channel mapping');
    }
  }

  toGroup(channel: EdgeRuntimeChannel): string {
    const tenantPrefix = `tenant:${this.segment(this.tenantId)}`;
    switch (channel.kind) {
      case 'tenant-inbox':
        return `${tenantPrefix}:central:events`;
      case 'worker-commands':
        return `${tenantPrefix}:worker:${this.segment(channel.workerId)}`;
    }
  }

  private segment(value: string): string {
    if (!value) {
      throw new Error('edge worker Web PubSub group segment cannot be empty');
    }
    return encodeURIComponent(value);
  }
}
