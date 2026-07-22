/**
 * Durable outbound result queue for the browser edge worker.
 *
 * Weak-network is a first-class edge capability: capture and analysis complete locally, and the small
 * structured result must reach central even if the network drops between finishing the turn and delivering
 * it. A completed turn's result is persisted here BEFORE it is published; it is removed only after central
 * has accepted it. When the transport reconnects (same lease) or the tab reloads and central re-drives the
 * pending turn under a new lease, the saved result is replayed instead of re-capturing the device.
 *
 * A queued result intentionally stores NO lease or worker identity. Those are lease-scoped and would be
 * stale after a reconnect or reassignment, so they are stamped at flush time from the live run. This keeps
 * one durable record valid across a transport blip (same lease) and a full reload (new lease), and reuses
 * central's existing restart-with-context turn replay rather than inventing a second delivery channel.
 */

/** A completed-turn result awaiting acknowledged delivery to central. Free of lease/worker identity. */
export interface QueuedResult {
  queueId: string;
  sessionId: string;
  turnSeq: number;
  /** Digest of the turn input this result answers, so a re-delivered input can be memo-matched. */
  digest: string;
  type: 'turn.completed' | 'turn.failed';
  /** The result payload (`TurnCompletedPayload` | `TurnFailedPayload`), with no lease identity. */
  payload: unknown;
  enqueuedAt: string;
}

/**
 * Persistence seam for the outbound queue. The runtime never assumes a backend: tests use the in-memory
 * store, the browser worker uses the `localStorage`-backed store so results survive a tab reload.
 */
export interface OutboundQueueStore {
  list(): QueuedResult[] | Promise<QueuedResult[]>;
  add(item: QueuedResult): void | Promise<void>;
  remove(queueId: string): void | Promise<void>;
}

/** Process-lifetime store. Loses items on reload; used by tests and non-durable hosts. */
export class InMemoryOutboundQueueStore implements OutboundQueueStore {
  private readonly items: QueuedResult[] = [];

  list(): QueuedResult[] {
    return this.items.map((item) => ({ ...item }));
  }

  add(item: QueuedResult): void {
    this.items.push({ ...item });
  }

  remove(queueId: string): void {
    const index = this.items.findIndex((item) => item.queueId === queueId);
    if (index >= 0) {
      this.items.splice(index, 1);
    }
  }
}

/** The minimal `Storage` surface the browser store needs (satisfied by `window.localStorage`). */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * `localStorage`-backed store: the queue survives a tab reload or crash, so a result computed just before a
 * disconnect is replayed once the session is re-established. Corrupt/foreign values are treated as empty
 * rather than throwing, so a bad key never wedges the worker.
 */
export class LocalStorageOutboundQueueStore implements OutboundQueueStore {
  private readonly key: string;

  constructor(private readonly storage: WebStorageLike, namespace: string) {
    this.key = `${namespace}:outbound-results`;
  }

  list(): QueuedResult[] {
    const raw = this.storage.getItem(this.key);
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? (parsed as QueuedResult[]) : [];
    } catch {
      return [];
    }
  }

  add(item: QueuedResult): void {
    const items = this.list();
    items.push(item);
    this.write(items);
  }

  remove(queueId: string): void {
    this.write(this.list().filter((item) => item.queueId !== queueId));
  }

  private write(items: QueuedResult[]): void {
    if (items.length === 0) {
      this.storage.removeItem(this.key);
      return;
    }
    this.storage.setItem(this.key, JSON.stringify(items));
  }
}

export function newQueuedResult(input: Omit<QueuedResult, 'queueId' | 'enqueuedAt'>): QueuedResult {
  return {
    ...input,
    queueId: `${input.sessionId}:${input.turnSeq}:${crypto.randomUUID()}`,
    enqueuedAt: new Date().toISOString()
  };
}
