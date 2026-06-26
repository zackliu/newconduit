import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebPubSubClient } from '@azure/web-pubsub-client';
import { AgentRuntimeClient } from '../../sdk/src';
import { WebPubSubTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { CentralHttpServer } from '../../src/central/http/central-http-server';
import { registerPocCentralRoutes } from '../../src/central/http/poc-routes';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import { DockerWorkspaceAdapter, WebPubSubClientAdapter } from '../../src/sidecar/adapters';
import { SidecarDaemon } from '../../src/sidecar';
import { COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS, WebPubSubRuntimeChannelMapper, type RuntimeEvent, type SessionAssignPayload, type SessionRecord, type WorkerRecord } from '../../src/shared';
import type { SidecarAgentProcessAdapter, SidecarAgentProcessEventHandler, SidecarAgentProcessInput, SidecarAgentProcessStartInput, SidecarAgentTurnResult } from '../../src/sidecar/contracts';
import { isCredentialUnavailable, loadTestEnv } from '../support/test-env';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TENANT_ID = 'poc';
const WEB_PUBSUB_TENANT_INBOX_GROUP = new WebPubSubRuntimeChannelMapper(TENANT_ID).toGroup({ kind: 'tenant-inbox' });

class NoopAgentProcessAdapter implements SidecarAgentProcessAdapter {
  async start(_input: SidecarAgentProcessStartInput): Promise<void> {
    return;
  }

  async send(input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<SidecarAgentTurnResult> {
    const message = `noop:${input.message}`;
    await emit({
      type: 'output',
      payload: {
        message
      }
    });
    return { message };
  }
}

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
        message: 'integration test'
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
    await stopWebPubSubClient(client);
    await transport.stop();
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
    agentProcessAdapter: new NoopAgentProcessAdapter()
  });
  registerPocCentralRoutes(server, central);

  try {
    await central.start();
    const port = await server.listen();

    await sidecar.startStandaloneWorker({
      centralUrl: `http://localhost:${port}`,
      tenantId,
      sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
      labels: { agent: 'copilot' },
      capacity: 1,
      allocatable: 1
    });

    const worker = await waitForReadyWorker(storage);
    assert.equal(worker.tenantId, tenantId);
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
    await sidecar.stop();
    await transport.stop();
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: client SDK creates session and assignment reaches registered worker', async (context) => {
  const env = loadTestEnv();
  const endpoint = process.env.WEBPUBSUB_ENDPOINT ?? env.WEBPUBSUB_ENDPOINT;
  const hubName = process.env.WEBPUBSUB_HUB ?? env.WEBPUBSUB_HUB ?? 'agentruntimepoc';

  if (!endpoint) {
    context.skip('tests/.env missing WEBPUBSUB_ENDPOINT');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'ars-sdk-wps-'));
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
    agentProcessAdapter: new NoopAgentProcessAdapter()
  });
  const channelMapper = new WebPubSubRuntimeChannelMapper(tenantId);
  let commandClient: WebPubSubClient | undefined;
  let sdk: AgentRuntimeClient | undefined;
  registerPocCentralRoutes(server, central);

  try {
    await central.start();
    const port = await server.listen();
    const centralUrl = `http://localhost:${port}`;

    await sidecar.startStandaloneWorker({
      centralUrl,
      tenantId,
      sidecarClass: COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS,
      labels: { agent: 'copilot' },
      capacity: 1,
      allocatable: 1
    });
    const worker = await waitForReadyWorker(storage);
    const workerCommandGrant = await transport.issueSidecarConnection({
      principal: { principalId: 'assignment-worker-subscriber', type: 'service' },
      channels: [{ kind: 'worker-commands', workerId: worker.workerId }]
    });
    commandClient = new WebPubSubClient(workerCommandGrant.url, {
      autoReconnect: false,
      autoRejoinGroups: false
    });

    let timeout: NodeJS.Timeout | undefined;
    let receivedResolve: (event: RuntimeEvent<SessionAssignPayload>) => void;
    const assignmentReceived = new Promise<RuntimeEvent<SessionAssignPayload>>((resolve, reject) => {
      receivedResolve = resolve;
      timeout = setTimeout(() => reject(new Error('timed out waiting for session.assign worker command')), 20_000);
    });
    commandClient.on('group-message', (message) => {
      if (message.message.group !== channelMapper.toGroup({ kind: 'worker-commands', workerId: worker.workerId })) {
        return;
      }
      const event = message.message.data as RuntimeEvent<SessionAssignPayload>;
      if (event.type === 'session.assign') {
        clearTimeout(timeout);
        receivedResolve(event);
      }
    });
    await commandClient.start();

    sdk = new AgentRuntimeClient({ centralUrl, tenantId });
    await sdk.connect();
    const { session: sdkSession } = await sdk.sessions.start({
      agent: 'copilot-poc',
      input: { message: 'assign this session' },
      workspace: { source: 'empty' }
    });

    const assignment = await assignmentReceived;
    assert.equal(assignment.workerId, worker.workerId);
    assert.equal(assignment.payload.workerId, worker.workerId);
    assert.equal(typeof assignment.payload.sessionLeaseId, 'string');
    assert.equal(assignment.payload.resolvedAgentSpec.agentSpecId, 'copilot-poc');
    assert.equal(assignment.payload.resolvedAgentSpec.sidecarClass, COPILOT_PROCESS_WRAPPER_SIDECAR_CLASS);
    assert.equal(typeof assignment.payload.workspaceRef, 'string');

    const storedSession = await storage.readSession(assignment.payload.sessionId) as SessionRecord | undefined;
    assert.equal(assignment.payload.sessionId, sdkSession.id);
    assert.equal(storedSession?.nextTurnSeq, 2);
    assert.equal(storedSession?.status, 'starting');
    assert.equal(storedSession?.currentWorkerId, worker.workerId);
    assert.equal(storedSession?.sessionLeaseId, assignment.payload.sessionLeaseId);
  } catch (error) {
    if (isCredentialUnavailable(error)) {
      context.skip('DefaultAzureCredential is unavailable; run az login to enable this integration test');
      return;
    }
    throw error;
  } finally {
    await sdk?.stop();
    await stopWebPubSubClient(commandClient);
    await sidecar.stop();
    await transport.stop();
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForReadyWorker(storage: LocalFileStorage): Promise<WorkerRecord> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const worker = (await storage.readWorkers()).find((candidate) => candidate.lifecycleState === 'active' && candidate.conditions.includes('ready'));
    if (worker) {
      return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('timed out waiting for ready worker');
}

async function stopWebPubSubClient(client: WebPubSubClient | undefined): Promise<void> {
  client?.stop();
}