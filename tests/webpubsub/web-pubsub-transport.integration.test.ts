import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebPubSubClient } from '@azure/web-pubsub-client';
import { WebPubSubTransportAdapter } from '../../src/central/adapters';
import type { RuntimeEvent } from '../../src/shared';
import { isCredentialUnavailable, loadTestEnv } from '../support/test-env';

const TENANT_ID = 'poc';
const WEB_PUBSUB_TENANT_INBOX_GROUP = `tenant:${TENANT_ID}:central:events`;

test('scenario: real Web PubSub client event reaches tenant inbox channel', async (context) => {
  const env = loadTestEnv();
  const endpoint = process.env.WEBPUBSUB_ENDPOINT ?? env.WEBPUBSUB_ENDPOINT;
  const hubName = process.env.WEBPUBSUB_HUB ?? env.WEBPUBSUB_HUB ?? 'agentruntimepoc';

  if (!endpoint) {
    context.skip('tests/.env missing WEBPUBSUB_ENDPOINT');
    return;
  }

  const transport = new WebPubSubTransportAdapter({ tenantId: TENANT_ID, endpoint, hubName });
  const event: RuntimeEvent = {
    eventId: `evt-integration-${crypto.randomUUID()}`,
    sequence: 0,
    type: 'session.create.requested',
    timestamp: new Date().toISOString(),
    actor: 'client',
    payload: {
      agent: {
        agentSpecId: 'copilot-poc'
      },
      input: {
        initialMessage: 'integration test',
        clientRequestId: `request-${crypto.randomUUID()}`
      },
      workspace: {
        source: 'empty'
      }
    }
  };

  let client: WebPubSubClient | undefined;
  try {
    let timeout: NodeJS.Timeout | undefined;
    let receivedResolve: (event: RuntimeEvent) => void;
    const received = new Promise<RuntimeEvent>((resolve, reject) => {
      receivedResolve = resolve;
      timeout = setTimeout(() => reject(new Error('timed out waiting for tenant inbox channel message')), 20_000);
    });

    await transport.subscribe({ kind: 'tenant-inbox' }, async (envelope) => {
      if (envelope.event.eventId === event.eventId) {
        clearTimeout(timeout);
        assert.equal(envelope.context.principal.principalId, 'integration-client');
        assert.equal(envelope.context.principal.type, 'user');
        receivedResolve(envelope.event);
      }
    });

    const token = await transport.issueClientConnection({
      principal: {
        principalId: 'integration-client',
        type: 'user'
      },
      channels: [{ kind: 'tenant-inbox' }]
    });
    client = new WebPubSubClient(token.url, {
      autoReconnect: false,
      autoRejoinGroups: false
    });
    await client.start();
    await client.sendToGroup(WEB_PUBSUB_TENANT_INBOX_GROUP, event, 'json');

    const receivedEvent = await received;
    assert.equal(receivedEvent.eventId, event.eventId);
    assert.equal(receivedEvent.type, 'session.create.requested');
    assert.deepEqual(receivedEvent.payload, event.payload);
  } catch (error) {
    if (isCredentialUnavailable(error)) {
      context.skip('DefaultAzureCredential is unavailable; run az login to enable this integration test');
      return;
    }
    throw error;
  } finally {
    client?.stop();
    transport.stop();
  }
});