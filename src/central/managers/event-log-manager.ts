import type { Clock, RuntimeEvent, RuntimeEventType, RuntimeStorage } from '../../shared';

/**
 * Appends ordered runtime facts to central storage so session history, replay, and client fan-out share the same source of truth.
 */
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
    sessionLeaseId?: string;
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