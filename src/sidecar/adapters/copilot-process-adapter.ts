import { mkdirSync } from 'node:fs';
import { DefaultAzureCredential, type AccessToken, type TokenCredential } from '@azure/identity';
import type { SidecarAgentProcessAdapter, SidecarAgentProcessEvent, SidecarAgentProcessEventHandler, SidecarAgentProcessInput, SidecarAgentProcessStartInput } from '../contracts';

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
  onPermissionRequest: unknown;
}

interface CopilotSdkSession {
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
    start(): Promise<unknown>;
  };
  RuntimeConnection: {
    forStdio(input: { path: string }): unknown;
    forTcp(input?: { path?: string; port?: number; connectionToken?: string }): unknown;
  };
  approveAll: unknown;
}

type CopilotSdkLoader = () => Promise<CopilotSdkModule>;
type ProviderTokenResolver = (scope: string) => Promise<AccessToken | null>;

interface ActiveGitHubCopilotSession {
  client: CopilotSdkClient;
  session: CopilotSdkSession;
}

export class CopilotProcessAdapter implements SidecarAgentProcessAdapter {
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

    const { CopilotClient, RuntimeConnection, approveAll } = await this.loadCopilotSdk();
    const client = new CopilotClient({
      connection: RuntimeConnection.forTcp(cliPath ? { path: cliPath } : {}),
      ...(gitHubToken ? { gitHubToken } : {}),
      workingDirectory: input.workspacePath,
      baseDirectory: input.copilotSessionStatePath,
      logLevel: 'error'
    });
    await client.start();
    const session = await client.createSession(await this.createCopilotSessionConfig({ gitHubToken, onPermissionRequest: approveAll }));
    this.sessions.set(input.sessionId, {
      client: client as unknown as CopilotSdkClient,
      session: session as unknown as CopilotSdkSession
    });
  }

  async send(input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<void> {
    if (!input.message) {
      throw new Error('message is required');
    }
    const active = this.sessions.get(input.sessionId);
    if (!active) {
      throw new Error(`agent session ${input.sessionId} is not running`);
    }
    let emittedFinalMessage = false;
    const unsubscribe = active.session.on((event) => {
      const mapped = this.mapSessionEvent(event);
      if (mapped) {
        if (mapped.payload.message) {
          emittedFinalMessage = true;
        }
        void emit(mapped);
      }
    });
    try {
      const result = await active.session.sendAndWait({ prompt: input.message }, 120_000);
      if (result && !emittedFinalMessage) {
        await emit({
          type: 'output',
          payload: {
            message: result.data.content,
            output: result.data
          }
        });
      }
    } catch (error) {
      await emit({
        type: 'output',
        payload: {
          error: {
            message: error instanceof Error ? error.message : String(error)
          }
        }
      });
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

  async pauseAtTurnBoundary(): Promise<void> {
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
          type: 'output',
          payload: {
            approvalRequested: event.data,
            internalEvent: { type: event.type, data: event.data }
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

  private async createCopilotSessionConfig(input: { gitHubToken?: string; onPermissionRequest: unknown }): Promise<CopilotSdkSessionConfig> {
    return {
      streaming: true,
      ...(input.gitHubToken ? { gitHubToken: input.gitHubToken } : {}),
      ...await this.resolveProviderSessionConfig(),
      onPermissionRequest: input.onPermissionRequest
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