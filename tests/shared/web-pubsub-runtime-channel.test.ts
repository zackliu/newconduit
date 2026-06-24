import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebPubSubRuntimeChannelMapper } from '../../src/shared';

test('scenario: Web PubSub runtime channel mapper produces tenant-prefixed groups', () => {
  const mapper = new WebPubSubRuntimeChannelMapper('tenant/a');

  assert.equal(mapper.toGroup({ kind: 'tenant-inbox' }), 'tenant:tenant%2Fa:central:events');
  assert.equal(mapper.toGroup({ kind: 'client-inbox', principalId: 'user/a' }), 'tenant:tenant%2Fa:client:user%2Fa:events');
  assert.equal(mapper.toGroup({ kind: 'session-events', sessionId: 'session/a' }), 'tenant:tenant%2Fa:session:session%2Fa');
  assert.equal(mapper.toGroup({ kind: 'worker-commands', workerId: 'worker/a' }), 'tenant:tenant%2Fa:worker:worker%2Fa');
});