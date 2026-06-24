import type { RuntimeEvent } from '../models';

export interface RuntimeTransport {
  publish(group: string, event: RuntimeEvent): Promise<void>;
  subscribe(group: string, handler: (event: RuntimeEvent) => Promise<void>): Promise<void>;
  negotiate(principal: string, groups: string[]): Promise<{ url: string }>;
}