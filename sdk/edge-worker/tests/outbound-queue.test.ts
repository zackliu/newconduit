import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InMemoryOutboundQueueStore,
  LocalStorageOutboundQueueStore,
  newQueuedResult,
  type QueuedResult,
  type WebStorageLike
} from '../src/outbound-queue';

class FakeWebStorage implements WebStorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  raw(key: string): string | null {
    return this.getItem(key);
  }
}

function sampleResult(turnSeq: number): QueuedResult {
  return newQueuedResult({
    sessionId: 'sess-1',
    turnSeq,
    digest: `d-${turnSeq}`,
    type: 'turn.completed',
    payload: { result: { message: `m-${turnSeq}`, output: { kind: 'device-evidence' } } }
  });
}

test('outbound queue: in-memory store adds, lists copies, and removes by id', () => {
  const store = new InMemoryOutboundQueueStore();
  const a = sampleResult(2);
  const b = sampleResult(3);
  store.add(a);
  store.add(b);
  assert.equal(store.list().length, 2);

  // list returns copies: mutating a returned item must not corrupt the stored record.
  const listed = store.list();
  listed[0].turnSeq = 999;
  assert.deepEqual(store.list().map((item) => item.turnSeq).sort((x, y) => x - y), [2, 3]);

  store.remove(a.queueId);
  assert.deepEqual(store.list().map((item) => item.turnSeq), [3]);
});

test('outbound queue: localStorage store persists across a simulated reload', () => {
  const storage = new FakeWebStorage();
  const first = new LocalStorageOutboundQueueStore(storage, 'rdd.edge');
  const queued = sampleResult(2);
  first.add(queued);

  // A brand-new store instance over the same storage is a reloaded tab: the result must still be there.
  const afterReload = new LocalStorageOutboundQueueStore(storage, 'rdd.edge');
  const restored = afterReload.list();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].queueId, queued.queueId);
  assert.equal(restored[0].digest, 'd-2');

  afterReload.remove(queued.queueId);
  assert.equal(afterReload.list().length, 0);
  // The key is cleared once empty rather than leaving a stale "[]" behind.
  assert.equal(storage.raw('rdd.edge:outbound-results'), null);
});

test('outbound queue: localStorage store treats corrupt content as empty instead of throwing', () => {
  const storage = new FakeWebStorage();
  storage.setItem('rdd.edge:outbound-results', '{ this is not json');
  const store = new LocalStorageOutboundQueueStore(storage, 'rdd.edge');
  assert.deepEqual(store.list(), []);
  // It still works after encountering corruption.
  const queued = sampleResult(5);
  store.add(queued);
  assert.deepEqual(store.list().map((item) => item.turnSeq), [5]);
});

test('outbound queue: newQueuedResult stamps a unique id and timestamp without lease identity', () => {
  const a = newQueuedResult({ sessionId: 's', turnSeq: 1, digest: 'd', type: 'turn.completed', payload: {} });
  const b = newQueuedResult({ sessionId: 's', turnSeq: 1, digest: 'd', type: 'turn.completed', payload: {} });
  assert.notEqual(a.queueId, b.queueId);
  assert.ok(a.enqueuedAt);
  // The durable record intentionally carries no sessionLeaseId / workerId (stamped at flush time).
  assert.ok(!('sessionLeaseId' in a));
  assert.ok(!('workerId' in a));
});
