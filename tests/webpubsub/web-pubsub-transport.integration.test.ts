import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebPubSubClient } from '@azure/web-pubsub-client';
import { WebPubSubTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { CentralHttpServer } from '../../src/central/http/central-http-server';
import { registerPocCentralRoutes } from '../../src/central/http/poc-routes';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { CopilotProcessAdapter, DockerWorkspaceAdapter, WebPubSubClientAdapter } from '../../src/sidecar/adapters';
import { WorkerRegistrationController } from '../../src/sidecar/controllers';
import { SidecarDaemon } from '../../src/sidecar';
import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, WebPubSubRuntimeChannelMapper, type RuntimeEvent, type WorkerRecord } from '../../src/shared';
import { isCredentialUnavailable, loadTestEnv } from '../support/test-env';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TENANT_ID = 'poc';
const WEB_PUBSUB_TENANT_INBOX_GROUP = new WebPubSubRuntimeChannelMapper(TENANT_ID).toGroup({ kind: 'tenant-inbox' });

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

test('scenario: sidecar negotiates real Web PubSub connection and registers worker', async (context) => {
  const env = loadTestEnv();
  const endpoint = process.env.WEBPUBSUB_ENDPOINT ?? env.WEBPUBSUB_ENDPOINT;
  const hubName = process.env.WEBPUBSUB_HUB ?? env.WEBPUBSUB_HUB ?? 'agentruntimepoc';

  if (!endpoint) {
    context.skip('tests/.env missing WEBPUBSUB_ENDPOINT');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'ars-sidecar-wps-'));
  const tenantId = `poc-${crypto.randomUUID()}`;
  const transport = new WebPubSubTransportAdapter({ tenantId, endpoint, hubName });
  const storage = new LocalFileStorage(root);
  const central = new CentralService({
    storage,
    eventTransport: transport,
    connectionIssuer: transport,
    tenant: {
      tenantId,
      storageRoot: root,
      webPubSubHub: hubName
    }
  });
  const server = new CentralHttpServer({ port: 0 });
  const sidecar = new SidecarDaemon({
    runtimeTransport: new WebPubSubClientAdapter({ tenantId }),
    workspaceAdapter: new DockerWorkspaceAdapter(),
    agentProcessAdapter: new CopilotProcessAdapter(),
    workerRegistrationEvents: new WorkerRegistrationController()
  });
  registerPocCentralRoutes(server, central);

  try {
    await central.start();
    const port = await server.listen();

    await sidecar.startStandaloneWorker({
      centralUrl: `http://localhost:${port}`,
      tenantId,
      sidecarId: 'e2e-sidecar-1',
      sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
      labels: { agent: 'copilot' },
      capacity: 1,
      allocatable: 1
    });

    const worker = await waitForWorker(storage, 'e2e-sidecar-1');
    assert.equal(worker.tenantId, tenantId);
    assert.equal(worker.sidecarId, 'e2e-sidecar-1');
    assert.equal(worker.sidecarClass, COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS);
    assert.deepEqual(worker.labels, { agent: 'copilot' });
    assert.equal(worker.lifecycleState, 'active');
    assert.deepEqual(worker.conditions, ['ready']);
  } catch (error) {
    if (isCredentialUnavailable(error)) {
      context.skip('DefaultAzureCredential is unavailable; run az login to enable this integration test');
      return;
    }
    throw error;
  } finally {
    sidecar.stop();
    transport.stop();
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForWorker(storage: LocalFileStorage, sidecarId: string): Promise<WorkerRecord> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const worker = (await storage.readWorkers()).find((candidate) => candidate.sidecarId === sidecarId);
    if (worker) {
      return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for worker ${sidecarId}`);
}