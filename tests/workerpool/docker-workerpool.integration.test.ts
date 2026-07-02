import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { AgentRuntimeClient, type AgentTurnEvent } from '../../sdk/client/src';
import { DockerHostPoolAdapter, WebPubSubTransportAdapter } from '../../src/central/adapters';
import { CentralService } from '../../src/central/central-service';
import { CentralHttpServer } from '../../src/central/http/central-http-server';
import { registerPocCentralRoutes } from '../../src/central/http/poc-routes';
import { LocalFileStorage } from '../../src/central/storage/local-file-storage';
import type { HostPoolInstanceRecord, SessionRecord, WorkerPoolRecord, WorkerRecord } from '../../src/shared';
import { COPILOT_STORAGE_CLASS, COPILOT_WORKER_LABELS } from '../support/config-fixtures';
import { isCredentialUnavailable, loadTestEnv } from '../support/test-env';

const execFileAsync = promisify(execFile);
const IMAGE_NAME = 'agent-runtime-sidecar-poc:test';

test('scenario: docker worker pool scales out sidecar capacity for SDK session and scales in after pause', async (context) => {
  if (process.env.RUN_DOCKER_WORKERPOOL_E2E !== '1') {
    context.skip('set RUN_DOCKER_WORKERPOOL_E2E=1 to run Docker WorkerPool end-to-end validation');
    return;
  }
  if (!await isDockerAvailable()) {
    context.skip('Docker is unavailable');
    return;
  }
  const env = loadTestEnv();
  const endpoint = process.env.WEBPUBSUB_ENDPOINT ?? env.WEBPUBSUB_ENDPOINT;
  const hubName = process.env.WEBPUBSUB_HUB ?? env.WEBPUBSUB_HUB ?? 'agentruntimepoc';
  const copilotModel = process.env.COPILOT_MODEL ?? env.COPILOT_MODEL;
  const copilotProviderType = process.env.COPILOT_PROVIDER_TYPE ?? env.COPILOT_PROVIDER_TYPE;
  const copilotProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL ?? env.COPILOT_PROVIDER_BASE_URL;
  if (!endpoint || !copilotModel || !copilotProviderType || !copilotProviderBaseUrl) {
    context.skip('tests/.env missing Web PubSub or Copilot provider configuration');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'ars-docker-workerpool-'));
  const tenantId = `poc-${crypto.randomUUID()}`;
  const poolId = `pool-${crypto.randomUUID()}`;
  const workerPool: WorkerPoolRecord = {
    poolId,
    tenantId,
    template: { labels: COPILOT_WORKER_LABELS, capacity: 1 },
    hostPoolControllerClass: 'docker',
    scalePolicy: {
      scaleOutMaxPendingPerTick: 1,
      scaleInIdleMs: 5000
    },
    centralUrlForWorkers: 'http://host.docker.internal:0'
  };
  const transport = new WebPubSubTransportAdapter({ tenantId, endpoint, hubName });
  const storage = new LocalFileStorage(root);
  const adapter = new DockerHostPoolAdapter({
    imageName: IMAGE_NAME,
    sidecarWorkRoot: join(root, 'docker-runtime'),
    snapshotRoot: join(root, 'snapshots'),
    env: {
      ...process.env,
      WEBPUBSUB_ENDPOINT: endpoint,
      WEBPUBSUB_HUB: hubName,
      COPILOT_MODEL: copilotModel,
      COPILOT_PROVIDER_TYPE: copilotProviderType,
      COPILOT_PROVIDER_BASE_URL: copilotProviderBaseUrl,
      ...(env.COPILOT_PROVIDER_TOKEN_SCOPE ? { COPILOT_PROVIDER_TOKEN_SCOPE: env.COPILOT_PROVIDER_TOKEN_SCOPE } : {})
    }
  });
  const central = new CentralService({
    storage,
    eventTransport: transport,
    connectionIssuer: transport,
    tenant: { tenantId, storageRoot: root, webPubSubHub: hubName },
    workerPools: [workerPool],
    hostPoolAdapters: { docker: adapter }
  });
  const server = new CentralHttpServer({ port: 0 });
  let sdk: AgentRuntimeClient | undefined;
  registerPocCentralRoutes(server, central);

  try {
    await central.start();
    const port = await server.listen();
    workerPool.centralUrlForWorkers = `http://host.docker.internal:${port}`;
    const centralUrl = `http://localhost:${port}`;
    sdk = new AgentRuntimeClient({ centralUrl, tenantId });
    await sdk.connect();

    const { session } = await sdk.sessions.start({
      agent: 'copilot-poc',
      input: { message: 'Start a Docker WorkerPool e2e session.' },
      workspace: { source: 'empty' },
      displayName: 'Docker WorkerPool e2e'
    });

    const instance = await waitForInstance(storage, (candidate) => candidate.poolId === poolId && candidate.state === 'ready' && Boolean(candidate.workerId), 120_000);
    assert.equal(typeof instance.containerId, 'string');
    assert.equal(typeof instance.workerId, 'string');
    const worker = await waitForActiveWorker(storage, instance.workerId!, 30_000);
    assert.deepEqual(worker.labels, COPILOT_WORKER_LABELS);
    assert.equal(worker.storageClass, COPILOT_STORAGE_CLASS);

    const running = await waitForSession(storage, session.id, (candidate) => candidate.status === 'running', 120_000);
    assert.equal(running.currentWorkerId, worker.workerId);

    const turn = await session.send({ message: 'Reply with exactly: worker pool ok' });
    const events = await collectTurnEvents(turn.events(), 180_000);
    assert.ok(events.some((event) => event.type === 'turn.completed'));

    await session.pause();
    await waitForSession(storage, session.id, (candidate) => candidate.status === 'paused', 60_000);
    await wait(5500);
    await central.reconcileSessionsForTenant(tenantId);
    const stopped = await waitForInstance(storage, (candidate) => candidate.instanceId === instance.instanceId && candidate.state === 'stopped', 60_000);
    assert.equal(stopped.workerId, worker.workerId);
  } catch (error) {
    if (isCredentialUnavailable(error)) {
      context.skip('DefaultAzureCredential is unavailable; run az login to enable this integration test');
      return;
    }
    const diagnostics = await collectDiagnostics(storage, poolId);
    if (error instanceof Error) {
      error.message = `${error.message}\n${diagnostics}`;
    }
    throw error;
  } finally {
    await sdk?.close();
    await cleanupDockerPool(poolId);
    await transport.stop();
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('scenario: docker worker pool restores session memory across worker recycle', async (context) => {
  if (process.env.RUN_DOCKER_WORKERPOOL_E2E !== '1') {
    context.skip('set RUN_DOCKER_WORKERPOOL_E2E=1 to run Docker WorkerPool end-to-end validation');
    return;
  }
  if (!await isDockerAvailable()) {
    context.skip('Docker is unavailable');
    return;
  }
  const env = loadTestEnv();
  const endpoint = process.env.WEBPUBSUB_ENDPOINT ?? env.WEBPUBSUB_ENDPOINT;
  const hubName = process.env.WEBPUBSUB_HUB ?? env.WEBPUBSUB_HUB ?? 'agentruntimepoc';
  const copilotModel = process.env.COPILOT_MODEL ?? env.COPILOT_MODEL;
  const copilotProviderType = process.env.COPILOT_PROVIDER_TYPE ?? env.COPILOT_PROVIDER_TYPE;
  const copilotProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL ?? env.COPILOT_PROVIDER_BASE_URL;
  if (!endpoint || !copilotModel || !copilotProviderType || !copilotProviderBaseUrl) {
    context.skip('tests/.env missing Web PubSub or Copilot provider configuration');
    return;
  }

  const marker = 'RESUME-OK-7f3a';
  const root = await mkdtemp(join(tmpdir(), 'ars-docker-memory-'));
  const tenantId = `poc-${crypto.randomUUID()}`;
  const poolId = `pool-${crypto.randomUUID()}`;
  const workerPool: WorkerPoolRecord = {
    poolId,
    tenantId,
    template: { labels: COPILOT_WORKER_LABELS, capacity: 1 },
    hostPoolControllerClass: 'docker',
    scalePolicy: {
      scaleOutMaxPendingPerTick: 1,
      scaleInIdleMs: 5000
    },
    centralUrlForWorkers: 'http://host.docker.internal:0'
  };
  const transport = new WebPubSubTransportAdapter({ tenantId, endpoint, hubName });
  const storage = new LocalFileStorage(root);
  const adapter = new DockerHostPoolAdapter({
    imageName: IMAGE_NAME,
    sidecarWorkRoot: join(root, 'docker-runtime'),
    snapshotRoot: join(root, 'snapshots'),
    env: {
      ...process.env,
      WEBPUBSUB_ENDPOINT: endpoint,
      WEBPUBSUB_HUB: hubName,
      COPILOT_MODEL: copilotModel,
      COPILOT_PROVIDER_TYPE: copilotProviderType,
      COPILOT_PROVIDER_BASE_URL: copilotProviderBaseUrl,
      ...(env.COPILOT_PROVIDER_TOKEN_SCOPE ? { COPILOT_PROVIDER_TOKEN_SCOPE: env.COPILOT_PROVIDER_TOKEN_SCOPE } : {})
    }
  });
  const central = new CentralService({
    storage,
    eventTransport: transport,
    connectionIssuer: transport,
    tenant: { tenantId, storageRoot: root, webPubSubHub: hubName },
    workerPools: [workerPool],
    hostPoolAdapters: { docker: adapter }
  });
  const server = new CentralHttpServer({ port: 0 });
  let sdk: AgentRuntimeClient | undefined;
  registerPocCentralRoutes(server, central);

  try {
    await central.start();
    const port = await server.listen();
    workerPool.centralUrlForWorkers = `http://host.docker.internal:${port}`;
    const centralUrl = `http://localhost:${port}`;
    sdk = new AgentRuntimeClient({ centralUrl, tenantId });
    await sdk.connect();

    const { session } = await sdk.sessions.start({
      agent: 'copilot-poc',
      input: { message: 'Start a Docker WorkerPool continuity session.' },
      workspace: { source: 'empty' },
      displayName: 'Docker WorkerPool continuity'
    });

    const runningOnA = await waitForSession(storage, session.id, (candidate) => candidate.status === 'running' && Boolean(candidate.currentWorkerId), 180_000);
    const workerAId = runningOnA.currentWorkerId!;

    const writeTurn = await session.send({ message: `Use your tools to create a file named continuity.txt in your current working directory whose exact contents are ${marker} with no extra characters. Reply with DONE once the file exists.` });
    const writeEvents = await collectTurnEvents(writeTurn.events(), 240_000);
    assert.ok(writeEvents.some((event) => event.type === 'turn.completed'));

    await session.pause();
    const paused = await waitForSession(storage, session.id, (candidate) => candidate.status === 'paused' && Boolean(candidate.latestSnapshotRef), 60_000);

    const capturedFile = join(root, 'snapshots', session.id, paused.latestSnapshotRef!, 'parts', 'workspace', 'continuity.txt');
    assert.equal((await readFile(capturedFile, 'utf8')).trim(), marker);

    await wait(5500);
    await central.reconcileSessionsForTenant(tenantId);
    await waitForWorkerRecycled(storage, workerAId, 60_000);

    await session.resume();
    const runningOnB = await waitForSession(storage, session.id, (candidate) => candidate.status === 'running' && Boolean(candidate.currentWorkerId) && candidate.currentWorkerId !== workerAId, 180_000);
    assert.notEqual(runningOnB.currentWorkerId, workerAId);

    const recallTurn = await session.send({ message: 'Read the file continuity.txt from your current working directory and reply with its exact contents.' });
    const recallEvents = await collectTurnEvents(recallTurn.events(), 240_000);
    assert.ok(recallEvents.some((event) => event.type === 'turn.completed'));
    assert.ok(turnEventsContain(recallEvents, marker), 'resumed worker reads the restored workspace file back');
  } catch (error) {
    if (isCredentialUnavailable(error)) {
      context.skip('DefaultAzureCredential is unavailable; run az login to enable this integration test');
      return;
    }
    const diagnostics = await collectDiagnostics(storage, poolId);
    if (error instanceof Error) {
      error.message = `${error.message}\n${diagnostics}`;
    }
    throw error;
  } finally {
    await sdk?.close();
    await cleanupDockerPool(poolId);
    await transport.stop();
    await server.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function collectTurnEvents(events: AsyncIterable<AgentTurnEvent>, timeoutMs: number): Promise<AgentTurnEvent[]> {
  return await Promise.race([
    (async () => {
      const collected: AgentTurnEvent[] = [];
      for await (const event of events) {
        collected.push(event);
      }
      return collected;
    })(),
    new Promise<AgentTurnEvent[]>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for Docker WorkerPool turn events')), timeoutMs))
  ]);
}

async function waitForInstance(storage: LocalFileStorage, predicate: (instance: HostPoolInstanceRecord) => boolean, timeoutMs: number): Promise<HostPoolInstanceRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const instance = (await storage.readHostPoolInstances()).find(predicate);
    if (instance) {
      return instance;
    }
    await wait(500);
  }
  throw new Error('timed out waiting for host pool instance');
}

async function waitForActiveWorker(storage: LocalFileStorage, workerId: string, timeoutMs: number): Promise<WorkerRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const worker = await storage.readWorker(workerId);
    if (worker?.lifecycleState === 'active') {
      return worker;
    }
    await wait(500);
  }
  throw new Error(`timed out waiting for worker ${workerId}`);
}

async function waitForWorkerRecycled(storage: LocalFileStorage, workerId: string, timeoutMs: number): Promise<WorkerRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const worker = await storage.readWorker(workerId);
    if (worker && worker.lifecycleState !== 'active') {
      return worker;
    }
    await wait(500);
  }
  throw new Error(`timed out waiting for worker ${workerId} to be recycled`);
}

function turnEventsContain(events: AgentTurnEvent[], marker: string): boolean {
  return events.some((event) => JSON.stringify(event).includes(marker));
}

async function waitForSession(storage: LocalFileStorage, sessionId: string, predicate: (session: SessionRecord) => boolean, timeoutMs: number): Promise<SessionRecord> {
  const deadline = Date.now() + timeoutMs;
  let lastSession: SessionRecord | undefined;
  while (Date.now() < deadline) {
    const session = await storage.readSession(sessionId);
    lastSession = session;
    if (session && predicate(session)) {
      return session;
    }
    await wait(500);
  }
  throw new Error(`timed out waiting for session ${sessionId}; last session=${JSON.stringify(lastSession)}`);
}

async function collectDiagnostics(storage: LocalFileStorage, poolId: string): Promise<string> {
  const [sessions, workers, instances] = await Promise.all([
    storage.readSessions(),
    storage.readWorkers(),
    storage.readHostPoolInstances()
  ]);
  const logs: string[] = [];
  for (const instance of instances.filter((candidate) => candidate.poolId === poolId && candidate.containerId)) {
    try {
      const { stdout, stderr } = await execFileAsync('docker', ['logs', instance.containerId!], { maxBuffer: 1024 * 1024 });
      logs.push(`container ${instance.containerId} logs:\n${stdout}\n${stderr}`);
    } catch (error) {
      logs.push(`container ${instance.containerId} logs unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [
    `sessions=${JSON.stringify(sessions, null, 2)}`,
    `workers=${JSON.stringify(workers, null, 2)}`,
    `instances=${JSON.stringify(instances, null, 2)}`,
    ...logs
  ].join('\n');
}

async function cleanupDockerPool(poolId: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync('docker', ['ps', '-aq', '--filter', `label=agent-runtime-sidecar.pool=${poolId}`]);
    const containerIds = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (containerIds.length > 0) {
      await execFileAsync('docker', ['rm', '-f', ...containerIds]);
    }
  } catch {
    return;
  }
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}