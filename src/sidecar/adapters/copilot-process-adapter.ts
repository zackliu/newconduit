import { mkdirSync } from 'node:fs';
import { DefaultAzureCredential, type AccessToken, type TokenCredential } from '@azure/identity';
import type { SidecarAgentProcessAdapter, SidecarAgentProcessEvent, SidecarAgentProcessEventHandler, SidecarAgentProcessInput, SidecarAgentProcessStartInput, SidecarAgentTurnResult, SidecarInteractionResponseInput } from '../contracts';

/** A suspended interaction turn can wait indefinitely for an off-agent responder; do not abort agent work. */
const INTERACTION_TURN_TIMEOUT_MS = 24 * 60 * 60 * 1000;

interface CopilotSdkClient {
  stop(): Promise<unknown>;
}

interface CopilotSdkProviderConfig {
  type: 'azure' | 'openai';
  baseUrl: string;
  bearerToken?: string;
  wireApi?: 'completions' | 'responses';
  azure?: {
    apiVersion: string;
  };
}

interface CopilotSdkSessionConfig {
  streaming: boolean;
  gitHubToken?: string;
  model?: string;
  provider?: CopilotSdkProviderConfig;
  onPermissionRequest?: () => { kind: 'no-result' };
  tools?: Array<{ name: string; description?: string; parameters?: unknown }>;
}

interface CopilotSdkPendingRpc {
  permissions: { handlePendingPermissionRequest(input: { requestId: string; result: unknown }): Promise<unknown> };
  tools: { handlePendingToolCall(input: { requestId: string; result: unknown }): Promise<unknown> };
}

interface CopilotSdkSession {
  rpc: CopilotSdkPendingRpc;
  sendAndWait(input: { prompt: string }, timeout?: number): Promise<{ data: { content: string } } | undefined>;
  on(handler: (event: CopilotSdkSessionEvent) => void): () => void;
  disconnect(): Promise<void>;
}

interface CopilotSdkSessionEvent {
  type: string;
  data: Record<string, unknown>;
}

interface CopilotSdkModule {
  CopilotClient: new (options: Record<string, unknown>) => CopilotSdkClient & {
    createSession(options: CopilotSdkSessionConfig): Promise<CopilotSdkSession>;
    resumeSession(sessionId: string, options: CopilotSdkSessionConfig): Promise<CopilotSdkSession>;
    getLastSessionId(): Promise<string | undefined>;
    start(): Promise<unknown>;
  };
  RuntimeConnection: {
    forStdio(input: { path: string }): unknown;
    forTcp(input?: { path?: string; port?: number; connectionToken?: string }): unknown;
  };
}

type CopilotSdkLoader = () => Promise<CopilotSdkModule>;
type ProviderTokenResolver = (scope: string) => Promise<AccessToken | null>;

interface ActiveGitHubCopilotSession {
  client: CopilotSdkClient;
  session: CopilotSdkSession;
  /** Pending Copilot permission requests keyed by requestId. Retained so a session-scoped grant can
   *  rebuild the per-request approval descriptor the Copilot permission rule engine remembers. */
  pendingPermissionRequests: Map<string, Record<string, unknown>>;
}

export class CopilotProcessAdapter implements SidecarAgentProcessAdapter {
  static readonly classId = 'copilot-process';
  private readonly sessions = new Map<string, ActiveGitHubCopilotSession>();

  constructor(
    private readonly loadCopilotSdk: CopilotSdkLoader = async () => await import('@github/copilot-sdk') as unknown as CopilotSdkModule,
    private readonly resolveProviderToken: ProviderTokenResolver = createDefaultProviderTokenResolver()
  ) {}

  async start(input: SidecarAgentProcessStartInput): Promise<void> {
    if (!input.workspacePath || !input.copilotSessionStatePath) {
      throw new Error('workspacePath and copilotSessionStatePath are required');
    }
    mkdirSync(input.workspacePath, { recursive: true });
    mkdirSync(input.copilotSessionStatePath, { recursive: true });
    const existing = this.sessions.get(input.sessionId);
    if (existing) {
      await this.stop({ sessionId: input.sessionId });
    }

    const cliPath = process.env.COPILOT_CLI_PATH?.trim();
    const gitHubToken = this.resolveGitHubToken();

    const { CopilotClient, RuntimeConnection } = await this.loadCopilotSdk();
    const client = new CopilotClient({
      connection: RuntimeConnection.forTcp(cliPath ? { path: cliPath } : {}),
      ...(gitHubToken ? { gitHubToken } : {}),
      workingDirectory: input.workspacePath,
      baseDirectory: input.copilotSessionStatePath,
      logLevel: 'error'
    });
    await client.start();
    const sessionConfig = await this.createCopilotSessionConfig({ gitHubToken });
    const restoredSessionId = await client.getLastSessionId();
    const session = restoredSessionId
      ? await client.resumeSession(restoredSessionId, sessionConfig)
      : await client.createSession(sessionConfig);
    this.sessions.set(input.sessionId, {
      client: client as unknown as CopilotSdkClient,
      session: session as unknown as CopilotSdkSession,
      pendingPermissionRequests: new Map()
    });
  }

  async send(input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<SidecarAgentTurnResult> {
    if (!input.message) {
      throw new Error('message is required');
    }
    const active = this.sessions.get(input.sessionId);
    if (!active) {
      throw new Error(`agent session ${input.sessionId} is not running`);
    }
    let lastStreamedMessage: string | undefined;
    let lastStreamedOutput: unknown;
    let publishChain: Promise<void> = Promise.resolve();
    const unsubscribe = active.session.on((event) => {
      this.capturePendingPermissionRequest(active, event);
      const mapped = this.mapSessionEvent(event);
      if (!mapped) {
        return;
      }
      if (mapped.type === 'output' && typeof mapped.payload.message === 'string' && mapped.payload.message.length > 0) {
        lastStreamedMessage = mapped.payload.message;
        lastStreamedOutput = mapped.payload.output;
      }
      publishChain = publishChain.then(() => emit(mapped));
    });
    try {
      const result = await active.session.sendAndWait({ prompt: input.message }, INTERACTION_TURN_TIMEOUT_MS);
      const completionContent = typeof result?.data.content === 'string' && result.data.content.length > 0 ? result.data.content : undefined;
      const message = completionContent ?? lastStreamedMessage;
      const output = result?.data ?? lastStreamedOutput;
      if (completionContent !== undefined && lastStreamedMessage === undefined) {
        publishChain = publishChain.then(() => emit({ type: 'output', payload: { message: completionContent, output: result?.data } }));
      }
      await publishChain;
      return { message, output };
    } finally {
      unsubscribe();
    }
  }

  async stop(input: { sessionId: string }): Promise<void> {
    const active = this.sessions.get(input.sessionId);
    if (!active) {
      return;
    }
    await active.session.disconnect();
    await active.client.stop();
    this.sessions.delete(input.sessionId);
  }

  async respondToInteraction(input: SidecarInteractionResponseInput): Promise<void> {
    const active = this.sessions.get(input.sessionId);
    if (!active) {
      throw new Error(`agent session ${input.sessionId} is not running`);
    }
    if (input.kind === 'approval') {
      const pendingRequest = active.pendingPermissionRequests.get(input.interactionId);
      active.pendingPermissionRequests.delete(input.interactionId);
      await active.session.rpc.permissions.handlePendingPermissionRequest({
        requestId: input.interactionId,
        result: this.toPermissionDecision(input.response, pendingRequest)
      });
      return;
    }
    await active.session.rpc.tools.handlePendingToolCall({
      requestId: input.interactionId,
      result: this.toToolResult(input.response)
    });
  }

  private capturePendingPermissionRequest(active: ActiveGitHubCopilotSession, event: CopilotSdkSessionEvent): void {
    if (event.type !== 'permission.requested') {
      return;
    }
    const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : undefined;
    const request = this.isRecord(event.data.permissionRequest) ? event.data.permissionRequest : undefined;
    if (requestId && request) {
      active.pendingPermissionRequests.set(requestId, request);
    }
  }

  private toPermissionDecision(response: unknown, pendingRequest?: Record<string, unknown>): unknown {
    const record = this.isRecord(response) ? response : {};
    if (record.decision === 'denied') {
      return { kind: 'reject' };
    }
    // A `session`-scoped client grant must become an `approve-for-session` decision so the Copilot
    // permission rule engine records a standing rule and auto-approves later matching requests
    // ("always approve"). `approve-for-session` carries what to remember as an `approval` descriptor
    // (tool prompts) or a `domain` (url prompts); that descriptor is derived from the original request
    // kind, which is why the pending request is retained and passed in rather than read from the
    // client response. A `once` grant approves this single request only.
    if (record.scope === 'session') {
      return this.toApproveForSessionDecision(pendingRequest);
    }
    return { kind: 'approve-once' };
  }

  private toApproveForSessionDecision(pendingRequest?: Record<string, unknown>): unknown {
    const approval = this.toSessionApprovalDescriptor(pendingRequest);
    if (approval) {
      return { kind: 'approve-for-session', approval };
    }
    if (pendingRequest?.kind === 'url' && typeof pendingRequest.url === 'string') {
      try {
        return { kind: 'approve-for-session', domain: new URL(pendingRequest.url).hostname };
      } catch {
        // A url that cannot be parsed cannot scope a domain rule; fall through to a bare session grant.
      }
    }
    return { kind: 'approve-for-session' };
  }

  private toSessionApprovalDescriptor(request?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!request || typeof request.kind !== 'string') {
      return undefined;
    }
    switch (request.kind) {
      case 'shell': {
        const commandIdentifiers = Array.isArray(request.commands)
          ? request.commands
              .map((command) => (this.isRecord(command) && typeof command.identifier === 'string' ? command.identifier : undefined))
              .filter((identifier): identifier is string => identifier !== undefined)
          : [];
        return { kind: 'commands', commandIdentifiers };
      }
      case 'read':
        return { kind: 'read' };
      case 'write':
        return { kind: 'write' };
      case 'mcp':
        return {
          kind: 'mcp',
          serverName: typeof request.serverName === 'string' ? request.serverName : '',
          toolName: typeof request.toolName === 'string' ? request.toolName : null
        };
      case 'memory':
        return { kind: 'memory' };
      case 'custom-tool':
        return { kind: 'custom-tool', toolName: typeof request.toolName === 'string' ? request.toolName : '' };
      case 'extension-management':
        return typeof request.operation === 'string'
          ? { kind: 'extension-management', operation: request.operation }
          : { kind: 'extension-management' };
      case 'extension-permission-access':
        return { kind: 'extension-permission-access', extensionName: typeof request.extensionName === 'string' ? request.extensionName : '' };
      default:
        return undefined;
    }
  }

  private toToolResult(response: unknown): unknown {
    const record = this.isRecord(response) ? response : {};
    return 'result' in record ? record.result : response;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  async pauseAtTurnBoundary(_input: { sessionId: string }): Promise<void> {
    return;
  }

  private mapSessionEvent(event: CopilotSdkSessionEvent): SidecarAgentProcessEvent | undefined {
    switch (event.type) {
      case 'assistant.message_delta':
        return {
          type: 'output',
          payload: {
            delta: typeof event.data.deltaContent === 'string' ? event.data.deltaContent : '',
            internalEvent: { type: event.type, data: event.data }
          }
        };
      case 'assistant.message':
        return {
          type: 'output',
          payload: {
            message: typeof event.data.content === 'string' ? event.data.content : '',
            output: event.data,
            internalEvent: { type: event.type, data: event.data }
          }
        };
      case 'tool.execution_start':
        return {
          type: 'output',
          payload: {
            toolStarted: {
              toolCallId: typeof event.data.toolCallId === 'string' ? event.data.toolCallId : 'unknown',
              toolName: typeof event.data.toolName === 'string' ? event.data.toolName : 'unknown',
              inputSummary: event.data.arguments
            },
            internalEvent: { type: event.type, data: event.data }
          }
        };
      case 'tool.execution_complete':
        return {
          type: 'output',
          payload: {
            toolCompleted: {
              toolCallId: typeof event.data.toolCallId === 'string' ? event.data.toolCallId : 'unknown',
              toolName: typeof event.data.toolCallId === 'string' ? event.data.toolCallId : 'unknown',
              outputSummary: event.data.result ?? event.data.error
            },
            internalEvent: { type: event.type, data: event.data }
          }
        };
      case 'permission.requested':
        return {
          type: 'interaction',
          payload: {
            interactionId: typeof event.data.requestId === 'string' ? event.data.requestId : crypto.randomUUID(),
            kind: 'approval',
            request: 'permissionRequest' in event.data ? event.data.permissionRequest : event.data
          }
        };
      case 'external_tool.requested':
        return {
          type: 'interaction',
          payload: {
            interactionId: typeof event.data.requestId === 'string' ? event.data.requestId : crypto.randomUUID(),
            kind: 'tool_call',
            request: {
              toolName: event.data.toolName,
              arguments: event.data.arguments,
              toolCallId: event.data.toolCallId
            }
          }
        };
      case 'session.error':
        return {
          type: 'output',
          payload: {
            error: {
              message: typeof event.data.message === 'string' ? event.data.message : 'Copilot session error',
              code: typeof event.data.errorType === 'string' ? event.data.errorType : undefined,
              details: event.data
            },
            internalEvent: { type: event.type, data: event.data }
          }
        };
      default:
        return undefined;
    }
  }

  private resolveGitHubToken(): string | undefined {
    return process.env.COPILOT_GITHUB_TOKEN?.trim()
      || process.env.GITHUB_TOKEN?.trim()
      || process.env.GH_TOKEN?.trim()
      || undefined;
  }

  private async createCopilotSessionConfig(input: { gitHubToken?: string }): Promise<CopilotSdkSessionConfig> {
    return {
      streaming: true,
      ...(input.gitHubToken ? { gitHubToken: input.gitHubToken } : {}),
      ...await this.resolveProviderSessionConfig(),
      // Register a deferring handler instead of omitting it. Providing any handler makes the Copilot CLI
      // route permission requests to us (requestPermission: true on both createSession and resumeSession);
      // returning `no-result` leaves each request pending so it surfaces as `permission.requested`, is
      // mapped to an interaction, and is resolved via rpc.permissions.handlePendingPermissionRequest.
      // Omitting the handler sets requestPermission: false on createSession, which makes the CLI auto-deny
      // every tool for fresh sessions ("Permission denied and could not request permission from user").
      onPermissionRequest: () => ({ kind: 'no-result' })
    };
  }

  private async resolveProviderSessionConfig(): Promise<Pick<CopilotSdkSessionConfig, 'model' | 'provider'> | undefined> {
    const baseUrl = process.env.COPILOT_PROVIDER_BASE_URL?.trim();
    if (!baseUrl) {
      return undefined;
    }

    const model = this.requireEnv('COPILOT_MODEL');
    const providerType = this.parseProviderType(this.requireEnv('COPILOT_PROVIDER_TYPE'));
    const provider = this.createProviderConfig({
      type: providerType,
      baseUrl,
      bearerToken: await this.resolveProviderBearerToken(),
      wireApi: this.parseWireApi(process.env.COPILOT_PROVIDER_WIRE_API?.trim()),
      azureApiVersion: process.env.COPILOT_PROVIDER_AZURE_API_VERSION?.trim() || undefined
    });
    return {
      model,
      provider
    };
  }

  private createProviderConfig(input: {
    type: CopilotSdkProviderConfig['type'];
    baseUrl: string;
    bearerToken?: string;
    wireApi?: CopilotSdkProviderConfig['wireApi'];
    azureApiVersion?: string;
  }): CopilotSdkProviderConfig {
    const provider: CopilotSdkProviderConfig = {
      type: input.type,
      baseUrl: input.baseUrl,
      ...(input.bearerToken ? { bearerToken: input.bearerToken } : {}),
      ...(input.wireApi ? { wireApi: input.wireApi } : {})
    };
    if (input.type === 'azure' && input.azureApiVersion) {
      provider.azure = { apiVersion: input.azureApiVersion };
    }
    return provider;
  }

  private async resolveProviderBearerToken(): Promise<string> {
    const scope = process.env.COPILOT_PROVIDER_TOKEN_SCOPE?.trim() || 'https://cognitiveservices.azure.com/.default';
    const token = await this.resolveProviderToken(scope);
    if (!token?.token) {
      throw new Error(`Azure identity did not return a provider access token for scope ${scope}`);
    }
    return token.token;
  }

  private requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
      throw new Error(`${name} is required when COPILOT_PROVIDER_BASE_URL is set`);
    }
    return value;
  }

  private parseProviderType(value: string): CopilotSdkProviderConfig['type'] {
    if (value === 'azure' || value === 'openai') {
      return value;
    }
    throw new Error('COPILOT_PROVIDER_TYPE must be "azure" or "openai"');
  }

  private parseWireApi(value: string | undefined): CopilotSdkProviderConfig['wireApi'] | undefined {
    if (!value) {
      return undefined;
    }
    if (value === 'completions' || value === 'responses') {
      return value;
    }
    throw new Error('COPILOT_PROVIDER_WIRE_API must be "completions" or "responses"');
  }
}

function createDefaultProviderTokenResolver(credential: TokenCredential = new DefaultAzureCredential()): ProviderTokenResolver {
  return async (scope: string) => await credential.getToken(scope);
}