import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CopilotProcessAdapter } from '../../src/sidecar/adapters';
import type { SidecarAgentProcessStartInput } from '../../src/sidecar/contracts';
import { loadTestEnv } from '../support/test-env';

class FakeCopilotSession {
  readonly prompts: string[] = [];
  disconnected = false;

  on(): () => void {
    return () => undefined;
  }

  async sendAndWait(input: { prompt: string }): Promise<{ data: { content: string } }> {
    this.prompts.push(input.prompt);
    return { data: { content: `copilot:${input.prompt}` } };
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

class FakeCopilotClient {
  static readonly instances: FakeCopilotClient[] = [];

  readonly session = new FakeCopilotSession();
  createSessionOptions: Record<string, unknown> | undefined;
  started = false;
  stopped = false;

  constructor(readonly options: Record<string, unknown>) {
    FakeCopilotClient.instances.push(this);
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async createSession(options: { streaming: boolean; gitHubToken?: string; model?: string; provider?: unknown; onPermissionRequest: unknown }): Promise<FakeCopilotSession> {
    this.createSessionOptions = options;
    return this.session;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

test('scenario: Copilot provider env is passed to SDK with Azure Identity bearer token', async () => {
  FakeCopilotClient.instances.length = 0;
  const requestedScopes: string[] = [];
  const originalCopilotModel = process.env.COPILOT_MODEL;
  const originalCopilotProviderType = process.env.COPILOT_PROVIDER_TYPE;
  const originalCopilotProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  const originalCopilotProviderWireApi = process.env.COPILOT_PROVIDER_WIRE_API;
  const originalCopilotProviderAzureApiVersion = process.env.COPILOT_PROVIDER_AZURE_API_VERSION;
  const originalFetch = globalThis.fetch;
  process.env.COPILOT_MODEL = 'demo-deployment';
  process.env.COPILOT_PROVIDER_TYPE = 'azure';
  process.env.COPILOT_PROVIDER_BASE_URL = 'https://example.openai.azure.com';
  delete process.env.COPILOT_PROVIDER_WIRE_API;
  process.env.COPILOT_PROVIDER_AZURE_API_VERSION = '2024-12-01-preview';
  globalThis.fetch = async () => {
    throw new Error('sidecar must not call provider HTTP directly');
  };

  const adapter = new CopilotProcessAdapter(async () => ({
    CopilotClient: FakeCopilotClient,
    RuntimeConnection: {
      forStdio: (input: { path: string }) => ({ kind: 'stdio', ...input }),
      forTcp: (input?: { path?: string }) => ({ kind: 'tcp', ...input })
    },
    approveAll: async () => true
  }), async (scope) => {
    requestedScopes.push(scope);
    return { token: 'test-msi-token', expiresOnTimestamp: Date.now() + 3600_000 };
  });
  const outputs: unknown[] = [];

  try {
    await adapter.start(startInput());
    await adapter.send({ sessionId: 'session-1', turnSeq: 1, message: 'hello' }, async (event) => {
      outputs.push(event.payload);
    });

    const [client] = FakeCopilotClient.instances;
    assert.ok(client);
    assert.equal(client.started, true);
    assert.deepEqual(client.options.connection, { kind: 'tcp' });
    assert.equal(client.options.workingDirectory, 'workspace-path');
    assert.equal(client.options.baseDirectory, 'copilot-state-path');
    assert.equal(typeof client.createSessionOptions?.onPermissionRequest, 'function');
    assert.deepEqual(requestedScopes, ['https://cognitiveservices.azure.com/.default']);
    assert.deepEqual({ ...client.createSessionOptions, onPermissionRequest: undefined }, {
      streaming: true,
      model: 'demo-deployment',
      provider: {
        type: 'azure',
        baseUrl: 'https://example.openai.azure.com',
        bearerToken: 'test-msi-token',
        azure: {
          apiVersion: '2024-12-01-preview'
        }
      },
      onPermissionRequest: undefined
    });
    assert.deepEqual(client.session.prompts, ['hello']);
    assert.deepEqual(outputs, [{ message: 'copilot:hello', output: { content: 'copilot:hello' } }]);

    await adapter.stop({ sessionId: 'session-1' });
    assert.equal(client.session.disconnected, true);
    assert.equal(client.stopped, true);
  } finally {
    restoreEnv('COPILOT_MODEL', originalCopilotModel);
    restoreEnv('COPILOT_PROVIDER_TYPE', originalCopilotProviderType);
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalCopilotProviderBaseUrl);
    restoreEnv('COPILOT_PROVIDER_WIRE_API', originalCopilotProviderWireApi);
    restoreEnv('COPILOT_PROVIDER_AZURE_API_VERSION', originalCopilotProviderAzureApiVersion);
    globalThis.fetch = originalFetch;
  }
});

test('scenario: OpenAI-compatible Copilot provider env is passed without URL conversion', async () => {
  FakeCopilotClient.instances.length = 0;
  const originalCopilotModel = process.env.COPILOT_MODEL;
  const originalCopilotProviderType = process.env.COPILOT_PROVIDER_TYPE;
  const originalCopilotProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  const originalCopilotProviderWireApi = process.env.COPILOT_PROVIDER_WIRE_API;
  const originalCopilotProviderAzureApiVersion = process.env.COPILOT_PROVIDER_AZURE_API_VERSION;
  process.env.COPILOT_MODEL = 'gpt-5.4-mini';
  process.env.COPILOT_PROVIDER_TYPE = 'openai';
  process.env.COPILOT_PROVIDER_BASE_URL = 'https://pmagent2.services.ai.azure.com/openai/v1';
  delete process.env.COPILOT_PROVIDER_WIRE_API;
  delete process.env.COPILOT_PROVIDER_AZURE_API_VERSION;

  const adapter = new CopilotProcessAdapter(async () => ({
    CopilotClient: FakeCopilotClient,
    RuntimeConnection: {
      forStdio: (input: { path: string }) => ({ kind: 'stdio', ...input }),
      forTcp: (input?: { path?: string }) => ({ kind: 'tcp', ...input })
    },
    approveAll: async () => true
  }), async () => ({ token: 'test-msi-token', expiresOnTimestamp: Date.now() + 3600_000 }));

  try {
    await adapter.start(startInput());

    const [client] = FakeCopilotClient.instances;
    assert.deepEqual({ ...client.createSessionOptions, onPermissionRequest: undefined }, {
      streaming: true,
      model: 'gpt-5.4-mini',
      provider: {
        type: 'openai',
        baseUrl: 'https://pmagent2.services.ai.azure.com/openai/v1',
        bearerToken: 'test-msi-token'
      },
      onPermissionRequest: undefined
    });
  } finally {
    await adapter.stop({ sessionId: 'session-1' });
    restoreEnv('COPILOT_MODEL', originalCopilotModel);
    restoreEnv('COPILOT_PROVIDER_TYPE', originalCopilotProviderType);
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalCopilotProviderBaseUrl);
    restoreEnv('COPILOT_PROVIDER_WIRE_API', originalCopilotProviderWireApi);
    restoreEnv('COPILOT_PROVIDER_AZURE_API_VERSION', originalCopilotProviderAzureApiVersion);
  }
});

test('scenario: real Copilot SDK agent uses provider env from tests env file', async (context) => {
  const env = loadTestEnv();
  const runRealCopilotAgent = process.env.RUN_REAL_COPILOT_AGENT_E2E ?? env.RUN_REAL_COPILOT_AGENT_E2E;
  if (runRealCopilotAgent !== '1') {
    context.skip('set RUN_REAL_COPILOT_AGENT_E2E=1 to run the real Copilot SDK agent smoke test');
    return;
  }
  const originalCopilotModel = process.env.COPILOT_MODEL;
  const originalCopilotProviderType = process.env.COPILOT_PROVIDER_TYPE;
  const originalCopilotProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  const originalCopilotProviderTokenScope = process.env.COPILOT_PROVIDER_TOKEN_SCOPE;
  process.env.COPILOT_MODEL = process.env.COPILOT_MODEL ?? env.COPILOT_MODEL;
  process.env.COPILOT_PROVIDER_TYPE = process.env.COPILOT_PROVIDER_TYPE ?? env.COPILOT_PROVIDER_TYPE;
  process.env.COPILOT_PROVIDER_BASE_URL = process.env.COPILOT_PROVIDER_BASE_URL ?? env.COPILOT_PROVIDER_BASE_URL;
  if (!process.env.COPILOT_PROVIDER_TOKEN_SCOPE && env.COPILOT_PROVIDER_TOKEN_SCOPE) {
    process.env.COPILOT_PROVIDER_TOKEN_SCOPE = env.COPILOT_PROVIDER_TOKEN_SCOPE;
  }
  if (!process.env.COPILOT_MODEL || !process.env.COPILOT_PROVIDER_TYPE || !process.env.COPILOT_PROVIDER_BASE_URL) {
    context.skip('set COPILOT_MODEL, COPILOT_PROVIDER_TYPE, and COPILOT_PROVIDER_BASE_URL for the Copilot SDK provider');
    restoreEnv('COPILOT_MODEL', originalCopilotModel);
    restoreEnv('COPILOT_PROVIDER_TYPE', originalCopilotProviderType);
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalCopilotProviderBaseUrl);
    restoreEnv('COPILOT_PROVIDER_TOKEN_SCOPE', originalCopilotProviderTokenScope);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'ars-real-copilot-agent-'));
  const adapter = new CopilotProcessAdapter();
  const outputs: unknown[] = [];
  try {
    await adapter.start({
      ...startInput(),
      workspacePath: join(root, 'workspace'),
      copilotSessionStatePath: join(root, 'copilot-state')
    });
    await adapter.send({ sessionId: 'session-1', turnSeq: 1, message: 'Reply with exactly: copilot-agent-ok' }, async (event) => {
      outputs.push(event.payload);
    });

    assert.ok(outputs.some((payload) => typeof (payload as { message?: unknown }).message === 'string'
      && /copilot-agent-ok/i.test((payload as { message: string }).message)), JSON.stringify(outputs));
  } finally {
    await adapter.stop({ sessionId: 'session-1' });
    await rm(root, { recursive: true, force: true });
    restoreEnv('COPILOT_MODEL', originalCopilotModel);
    restoreEnv('COPILOT_PROVIDER_TYPE', originalCopilotProviderType);
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalCopilotProviderBaseUrl);
    restoreEnv('COPILOT_PROVIDER_TOKEN_SCOPE', originalCopilotProviderTokenScope);
  }
});

function startInput(): SidecarAgentProcessStartInput {
  return {
    sessionId: 'session-1',
    workerId: 'worker-1',
    sessionLeaseId: 'lease-1',
    workspacePath: 'workspace-path',
    copilotSessionStatePath: 'copilot-state-path',
    resolvedAgentSpec: {
      agentSpecId: 'copilot-poc',
      labels: {},
      launch: { command: 'copilot', args: [] },
      sidecarClass: 'copilot-process-wrapper',
      workspaceClass: 'docker-workspace-volume-snapshot',
      toolProfile: 'copilot-poc-tools',
      workerSelector: { matchLabels: { agent: 'copilot' } },
      pausePolicy: 'turn-boundary-durable-pause',
      recoveryPolicy: 'restart-with-context',
      agentStatePolicy: 'copilot-session-volume-snapshot',
      idlePauseTimeoutMs: 60_000,
      version: 'test',
      resolvedAt: '2026-06-25T00:00:00.000Z',
      digest: 'test'
    }
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}