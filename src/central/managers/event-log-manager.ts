import type { Clock, RuntimeEvent, RuntimeEventType, RuntimeStorage } from '../../shared';

export class EventLogManager {
  constructor(private readonly storage: RuntimeStorage, private readonly clock: Clock) {}

  async append<TPayload>(input: {
    type: RuntimeEventType;
    actor: RuntimeEvent['actor'];
    payload: TPayload;
    sequence: number;
    sessionId?: string;
    workerId?: string;
    ackId?: string;
    turnSeq?: number;
    workerLeaseGeneration?: number;
  }): Promise<RuntimeEvent<TPayload>> {
    const event: RuntimeEvent<TPayload> = {
      eventId: crypto.randomUUID(),
      timestamp: this.clock.now(),
      ...input
    };
    await this.storage.appendEvent(event);
    return event;
  }
}