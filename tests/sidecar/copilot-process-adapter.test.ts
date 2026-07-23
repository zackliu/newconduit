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
  readonly permissionResponses: Array<{ requestId: string; result: unknown }> = [];
  readonly toolResponses: Array<{ requestId: string; result: unknown }> = [];
  readonly scriptedEvents: Array<{ type: string; data: Record<string, unknown> }> = [];
  private readonly handlers = new Set<(event: { type: string; data: Record<string, unknown> }) => void>();
  disconnected = false;

  readonly rpc = {
    permissions: {
      handlePendingPermissionRequest: async (input: { requestId: string; result: unknown }): Promise<void> => {
        this.permissionResponses.push(input);
      }
    },
    tools: {
      handlePendingToolCall: async (input: { requestId: string; result: unknown }): Promise<void> => {
        this.toolResponses.push(input);
      }
    }
  };

  on(handler: (event: { type: string; data: Record<string, unknown> }) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async sendAndWait(input: { prompt: string }): Promise<{ data: { content: string } }> {
    this.prompts.push(input.prompt);
    for (const event of this.scriptedEvents) {
      for (const handler of this.handlers) {
        handler(event);
      }
    }
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

  async getLastSessionId(): Promise<string | undefined> {
    return undefined;
  }

  async createSession(options: { streaming: boolean; gitHubToken?: string; model?: string; provider?: unknown; onPermissionRequest?: unknown; tools?: unknown }): Promise<FakeCopilotSession> {
    this.createSessionOptions = options;
    return this.session;
  }

  async resumeSession(_sessionId: string, options: { streaming: boolean; gitHubToken?: string; model?: string; provider?: unknown; onPermissionRequest?: unknown; tools?: unknown }): Promise<FakeCopilotSession> {
    this.createSessionOptions = options;
    return this.session;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

test('scenario: Copilot client is stopped when session configuration fails after process startup', async () => {
  FakeCopilotClient.instances.length = 0;
  const originalModel = process.env.COPILOT_MODEL;
  const originalProviderType = process.env.COPILOT_PROVIDER_TYPE;
  const originalProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  delete process.env.COPILOT_MODEL;
  process.env.COPILOT_PROVIDER_TYPE = 'azure';
  process.env.COPILOT_PROVIDER_BASE_URL = 'https://example.openai.azure.com';

  const adapter = new CopilotProcessAdapter(async () => ({
    CopilotClient: FakeCopilotClient,
    RuntimeConnection: {
      forStdio: (input: { path: string }) => ({ kind: 'stdio', ...input }),
      forTcp: (input?: { path?: string }) => ({ kind: 'tcp', ...input })
    },
    approveAll: async () => true
  }));

  try {
    await assert.rejects(
      adapter.start(startInput()),
      /COPILOT_MODEL is required when COPILOT_PROVIDER_BASE_URL is set/
    );
    const [client] = FakeCopilotClient.instances;
    assert.ok(client);
    assert.equal(client.started, true);
    assert.equal(client.stopped, true);
  } finally {
    restoreEnv('COPILOT_MODEL', originalModel);
    restoreEnv('COPILOT_PROVIDER_TYPE', originalProviderType);
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalProviderBaseUrl);
  }
});

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
    const permissionHandler = client.createSessionOptions?.onPermissionRequest as ((request: Record<string, unknown>) => unknown) | undefined;
    assert.equal(typeof permissionHandler, 'function');
    assert.deepEqual(permissionHandler?.({ kind: 'write', fileName: 'a.txt' }), { kind: 'no-result' });
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
      systemMessage: { mode: 'append', content: 'Test agent instructions.' },
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

test('scenario: session config never sends both gitHubToken and a custom provider (Copilot SDK rejects the pair)', async () => {
  // Regression guard for the real provider-path bug: `session.create` throws
  // "Cannot specify both gitHubToken and provider" when both are present. A custom
  // provider authenticates the model with its own bearer token, so the GitHub token
  // must be dropped from the session config whenever a provider is configured.
  FakeCopilotClient.instances.length = 0;
  const originalGitHubToken = process.env.COPILOT_GITHUB_TOKEN;
  const originalModel = process.env.COPILOT_MODEL;
  const originalProviderType = process.env.COPILOT_PROVIDER_TYPE;
  const originalProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  process.env.COPILOT_GITHUB_TOKEN = 'gh-token-abc';
  process.env.COPILOT_MODEL = 'demo-deployment';
  process.env.COPILOT_PROVIDER_TYPE = 'openai';
  process.env.COPILOT_PROVIDER_BASE_URL = 'https://provider.example/openai/v1';

  const adapter = new CopilotProcessAdapter(async () => ({
    CopilotClient: FakeCopilotClient,
    RuntimeConnection: {
      forStdio: (loc: { path: string }) => ({ kind: 'stdio', ...loc }),
      forTcp: (loc?: { path?: string }) => ({ kind: 'tcp', ...loc })
    },
    approveAll: async () => true
  }), async () => ({ token: 'provider-bearer', expiresOnTimestamp: Date.now() + 3600_000 }));

  try {
    await adapter.start(startInput());
    const [client] = FakeCopilotClient.instances;
    assert.ok(client);
    // Session config: provider present, gitHubToken absent.
    assert.equal('gitHubToken' in (client.createSessionOptions ?? {}), false);
    assert.deepEqual(client.createSessionOptions?.provider, {
      type: 'openai',
      baseUrl: 'https://provider.example/openai/v1',
      bearerToken: 'provider-bearer'
    });
    assert.equal(client.createSessionOptions?.model, 'demo-deployment');
    // The client/runtime connection still carries the GitHub token (that channel is separate).
    assert.equal(client.options.gitHubToken, 'gh-token-abc');
  } finally {
    await adapter.stop({ sessionId: 'session-1' });
    restoreEnv('COPILOT_GITHUB_TOKEN', originalGitHubToken);
    restoreEnv('COPILOT_MODEL', originalModel);
    restoreEnv('COPILOT_PROVIDER_TYPE', originalProviderType);
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalProviderBaseUrl);
  }
});

test('scenario: session config sends gitHubToken for a GitHub-hosted model when no custom provider is configured', async () => {
  FakeCopilotClient.instances.length = 0;
  const originalGitHubToken = process.env.COPILOT_GITHUB_TOKEN;
  const originalProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  process.env.COPILOT_GITHUB_TOKEN = 'gh-token-xyz';
  delete process.env.COPILOT_PROVIDER_BASE_URL;

  const adapter = new CopilotProcessAdapter(async () => ({
    CopilotClient: FakeCopilotClient,
    RuntimeConnection: {
      forStdio: (loc: { path: string }) => ({ kind: 'stdio', ...loc }),
      forTcp: (loc?: { path?: string }) => ({ kind: 'tcp', ...loc })
    },
    approveAll: async () => true
  }));

  try {
    await adapter.start(startInput());
    const [client] = FakeCopilotClient.instances;
    assert.ok(client);
    assert.equal(client.createSessionOptions?.gitHubToken, 'gh-token-xyz');
    assert.equal('provider' in (client.createSessionOptions ?? {}), false);
    assert.equal('model' in (client.createSessionOptions ?? {}), false);
  } finally {
    await adapter.stop({ sessionId: 'session-1' });
    restoreEnv('COPILOT_GITHUB_TOKEN', originalGitHubToken);
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalProviderBaseUrl);
  }
});

test('scenario: describeRuntime reports the real Copilot runtime identity (model + provider host) without secrets', async () => {
  const originalModel = process.env.COPILOT_MODEL;
  const originalProviderType = process.env.COPILOT_PROVIDER_TYPE;
  const originalProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  process.env.COPILOT_MODEL = 'gpt-5.4-mini';
  process.env.COPILOT_PROVIDER_TYPE = 'openai';
  process.env.COPILOT_PROVIDER_BASE_URL = 'https://provider.example/openai/v1';

  try {
    const identity = new CopilotProcessAdapter().describeRuntime();
    assert.deepEqual(identity, {
      runtime: 'copilot-process',
      model: 'gpt-5.4-mini',
      provider: 'openai',
      providerHost: 'provider.example'
    });
    // Non-secret contract: no bearer token or provider path leaks into the Worker description.
    assert.equal(Object.values(identity).some((value) => value.includes('/openai/v1')), false);
  } finally {
    restoreEnv('COPILOT_MODEL', originalModel);
    restoreEnv('COPILOT_PROVIDER_TYPE', originalProviderType);
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalProviderBaseUrl);
  }
});

test('scenario: describeRuntime reports a GitHub-hosted Copilot runtime when no custom provider is configured', async () => {
  const originalModel = process.env.COPILOT_MODEL;
  const originalProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  delete process.env.COPILOT_MODEL;
  delete process.env.COPILOT_PROVIDER_BASE_URL;

  try {
    assert.deepEqual(new CopilotProcessAdapter().describeRuntime(), {
      runtime: 'copilot-process',
      provider: 'github'
    });
  } finally {
    restoreEnv('COPILOT_MODEL', originalModel);
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalProviderBaseUrl);
  }
});

test('scenario: Central-provided runtime tools are registered without Sidecar delegation semantics', async () => {
  FakeCopilotClient.instances.length = 0;
  const originalProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  delete process.env.COPILOT_PROVIDER_BASE_URL;
  const adapter = new CopilotProcessAdapter(async () => ({
    CopilotClient: FakeCopilotClient,
    RuntimeConnection: {
      forStdio: (input: { path: string }) => ({ kind: 'stdio', ...input }),
      forTcp: (input?: { path?: string }) => ({ kind: 'tcp', ...input })
    },
    approveAll: async () => true
  }));
  const input = startInput();
  input.resolvedAgentSpec.runtimeTools = [{
    name: 'copilot_foundry',
    description: 'Ask the copilot-foundry subagent.',
    inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } } },
    binding: { kind: 'delegate', delegateId: 'copilot-foundry' }
  }];

  try {
    await adapter.start(input);
    const [client] = FakeCopilotClient.instances;
    const tools = client.createSessionOptions?.tools as Array<{ name: string; parameters: unknown }>;
    assert.deepEqual(tools.map((tool) => tool.name), ['copilot_foundry']);
    const permissionHandler = client.createSessionOptions?.onPermissionRequest as (request: Record<string, unknown>) => unknown;
    assert.deepEqual(permissionHandler({ kind: 'custom-tool', toolName: 'copilot_foundry' }), { kind: 'approve-once' });
    assert.deepEqual(permissionHandler({ kind: 'custom-tool', toolName: 'unregistered-tool' }), { kind: 'no-result' });
    assert.deepEqual(permissionHandler({ kind: 'write', fileName: 'a.txt' }), { kind: 'no-result' });

    client.session.scriptedEvents.push(
      { type: 'permission.requested', data: { requestId: 'runtime-permission', permissionRequest: { kind: 'custom-tool', toolName: 'copilot_foundry' } } },
      { type: 'permission.requested', data: { requestId: 'external-permission', permissionRequest: { kind: 'custom-tool', toolName: 'unregistered-tool' } } }
    );
    const emitted: Array<{ type: string }> = [];
    await adapter.send({ sessionId: 'session-1', turnSeq: 1, message: 'delegate' }, async (event) => {
      emitted.push(event);
    });
    assert.deepEqual(emitted.filter((event) => event.type === 'interaction').map((event) => event.type), ['interaction']);
  } finally {
    await adapter.stop({ sessionId: 'session-1' });
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalProviderBaseUrl);
  }
});

test('scenario: structured runtime tool responses are serialized for the Copilot external-tool RPC', async () => {
  FakeCopilotClient.instances.length = 0;
  const originalProviderBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  delete process.env.COPILOT_PROVIDER_BASE_URL;
  const adapter = new CopilotProcessAdapter(async () => ({
    CopilotClient: FakeCopilotClient,
    RuntimeConnection: {
      forStdio: (input: { path: string }) => ({ kind: 'stdio', ...input }),
      forTcp: (input?: { path?: string }) => ({ kind: 'tcp', ...input })
    },
    approveAll: async () => true
  }));

  try {
    await adapter.start(startInput());
    await adapter.respondToInteraction({
      sessionId: 'session-1',
      interactionId: 'runtime-tool-1',
      kind: 'tool_call',
      response: { result: { delegationCallId: 'call-1', status: 'queued' } }
    });

    const [client] = FakeCopilotClient.instances;
    assert.deepEqual(client.session.toolResponses, [{
      requestId: 'runtime-tool-1',
      result: '{"delegationCallId":"call-1","status":"queued"}'
    }]);
  } finally {
    await adapter.stop({ sessionId: 'session-1' });
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalProviderBaseUrl);
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
      systemMessage: { mode: 'append', content: 'Test agent instructions.' },
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

test('scenario: final assistant message from the stream becomes the turn result when sendAndWait returns no content', async () => {
  const originalModel = process.env.COPILOT_MODEL;
  const originalType = process.env.COPILOT_PROVIDER_TYPE;
  const originalBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  delete process.env.COPILOT_MODEL;
  delete process.env.COPILOT_PROVIDER_TYPE;
  delete process.env.COPILOT_PROVIDER_BASE_URL;

  class StreamingSession {
    private handler: ((event: { type: string; data: Record<string, unknown> }) => void) | undefined;

    readonly rpc = {
      permissions: { handlePendingPermissionRequest: async (): Promise<void> => undefined },
      tools: { handlePendingToolCall: async (): Promise<void> => undefined }
    };

    on(handler: (event: { type: string; data: Record<string, unknown> }) => void): () => void {
      this.handler = handler;
      return () => {
        this.handler = undefined;
      };
    }

    async sendAndWait(): Promise<{ data: { content: string } } | undefined> {
      this.handler?.({ type: 'assistant.message_delta', data: { deltaContent: 'Created ' } });
      this.handler?.({ type: 'assistant.message_delta', data: { deltaContent: 'a.txt' } });
      this.handler?.({ type: 'assistant.message', data: { content: 'Created a.txt in the working folder.' } });
      return undefined;
    }

    async disconnect(): Promise<void> {
      return;
    }
  }

  class StreamingClient {
    readonly session = new StreamingSession();

    constructor(readonly options: Record<string, unknown>) {}

    async start(): Promise<void> {
      return;
    }

    async getLastSessionId(): Promise<string | undefined> {
      return undefined;
    }

    async createSession(): Promise<StreamingSession> {
      return this.session;
    }

    async resumeSession(): Promise<StreamingSession> {
      return this.session;
    }

    async stop(): Promise<void> {
      return;
    }
  }

  const adapter = new CopilotProcessAdapter(async () => ({
    CopilotClient: StreamingClient,
    RuntimeConnection: {
      forStdio: (input: { path: string }) => ({ kind: 'stdio', ...input }),
      forTcp: (input?: { path?: string }) => ({ kind: 'tcp', ...input })
    },
    approveAll: async () => true
  }), async () => ({ token: 'test-msi-token', expiresOnTimestamp: Date.now() + 3600_000 }));

  const outputs: Array<{ message?: string; delta?: string }> = [];
  try {
    await adapter.start(startInput());
    const result = await adapter.send({ sessionId: 'session-1', turnSeq: 1, message: 'create a.txt' }, async (event) => {
      outputs.push(event.payload as { message?: string; delta?: string });
    });

    assert.equal(result.message, 'Created a.txt in the working folder.');
    assert.deepEqual(outputs.map((output) => output.delta ?? output.message), ['Created ', 'a.txt', 'Created a.txt in the working folder.']);
  } finally {
    await adapter.stop({ sessionId: 'session-1' });
    restoreEnv('COPILOT_MODEL', originalModel);
    restoreEnv('COPILOT_PROVIDER_TYPE', originalType);
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalBaseUrl);
  }
});

test('scenario: a session-scoped approval maps to an approve-for-session Copilot decision that carries the request approval descriptor', async () => {
  const originalModel = process.env.COPILOT_MODEL;
  const originalType = process.env.COPILOT_PROVIDER_TYPE;
  const originalBaseUrl = process.env.COPILOT_PROVIDER_BASE_URL;
  delete process.env.COPILOT_MODEL;
  delete process.env.COPILOT_PROVIDER_TYPE;
  delete process.env.COPILOT_PROVIDER_BASE_URL;

  const permissionDecisions = new Map<string, unknown>();

  class PermissionSession {
    private handler: ((event: { type: string; data: Record<string, unknown> }) => void) | undefined;

    readonly rpc = {
      permissions: {
        handlePendingPermissionRequest: async (input: { requestId: string; result: unknown }): Promise<void> => {
          permissionDecisions.set(input.requestId, input.result);
        }
      },
      tools: { handlePendingToolCall: async (): Promise<void> => undefined }
    };

    on(handler: (event: { type: string; data: Record<string, unknown> }) => void): () => void {
      this.handler = handler;
      return () => {
        this.handler = undefined;
      };
    }

    async sendAndWait(): Promise<{ data: { content: string } }> {
      this.handler?.({ type: 'permission.requested', data: { requestId: 'perm-write', permissionRequest: { kind: 'write', fileName: 'a.txt' } } });
      this.handler?.({ type: 'permission.requested', data: { requestId: 'perm-shell', permissionRequest: { kind: 'shell', commands: [{ identifier: 'ls', readOnly: true }] } } });
      this.handler?.({ type: 'permission.requested', data: { requestId: 'perm-read', permissionRequest: { kind: 'read', path: 'a.txt' } } });
      this.handler?.({ type: 'permission.requested', data: { requestId: 'perm-deny', permissionRequest: { kind: 'write', fileName: 'b.txt' } } });
      return { data: { content: 'ok' } };
    }

    async disconnect(): Promise<void> {
      return;
    }
  }

  class PermissionClient {
    readonly session = new PermissionSession();

    constructor(readonly options: Record<string, unknown>) {}

    async start(): Promise<void> {
      return;
    }

    async getLastSessionId(): Promise<string | undefined> {
      return undefined;
    }

    async createSession(): Promise<PermissionSession> {
      return this.session;
    }

    async resumeSession(): Promise<PermissionSession> {
      return this.session;
    }

    async stop(): Promise<void> {
      return;
    }
  }

  const adapter = new CopilotProcessAdapter(async () => ({
    CopilotClient: PermissionClient,
    RuntimeConnection: {
      forStdio: (input: { path: string }) => ({ kind: 'stdio', ...input }),
      forTcp: (input?: { path?: string }) => ({ kind: 'tcp', ...input })
    },
    approveAll: async () => true
  }), async () => ({ token: 'test-msi-token', expiresOnTimestamp: Date.now() + 3600_000 }));

  try {
    await adapter.start(startInput());
    await adapter.send({ sessionId: 'session-1', turnSeq: 1, message: 'edit some files' }, async () => undefined);

    await adapter.respondToInteraction({ sessionId: 'session-1', interactionId: 'perm-write', kind: 'approval', response: { decision: 'approved', scope: 'session' } });
    await adapter.respondToInteraction({ sessionId: 'session-1', interactionId: 'perm-shell', kind: 'approval', response: { decision: 'approved', scope: 'session' } });
    await adapter.respondToInteraction({ sessionId: 'session-1', interactionId: 'perm-read', kind: 'approval', response: { decision: 'approved', scope: 'once' } });
    await adapter.respondToInteraction({ sessionId: 'session-1', interactionId: 'perm-deny', kind: 'approval', response: { decision: 'denied' } });

    assert.deepEqual(permissionDecisions.get('perm-write'), { kind: 'approve-for-session', approval: { kind: 'write' } });
    assert.deepEqual(permissionDecisions.get('perm-shell'), { kind: 'approve-for-session', approval: { kind: 'commands', commandIdentifiers: ['ls'] } });
    assert.deepEqual(permissionDecisions.get('perm-read'), { kind: 'approve-once' });
    assert.deepEqual(permissionDecisions.get('perm-deny'), { kind: 'reject' });
  } finally {
    await adapter.stop({ sessionId: 'session-1' });
    restoreEnv('COPILOT_MODEL', originalModel);
    restoreEnv('COPILOT_PROVIDER_TYPE', originalType);
    restoreEnv('COPILOT_PROVIDER_BASE_URL', originalBaseUrl);
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
      instructions: 'Test agent instructions.',
      toolProfile: 'copilot-poc-tools',
      delegateRefs: { asCaller: [], asCallee: [] },
      runtimeTools: [],
      workerSelector: { matchLabels: { agent: 'copilot' } },
      pausePolicy: 'turn-boundary-durable-pause',
      recoveryPolicy: 'restart-with-context',
      idlePauseTimeoutMs: 120_000,
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