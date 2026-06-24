import { SystemClock, type Clock, type CreateSessionRequest, type RequestContext, type RuntimeEvent, type RuntimeStorage, type RuntimeTransport, type TenantContext } from '../shared';
import { CENTRAL_EVENTS_GROUP } from '../shared/protocol/web-pubsub-events';
import { WebPubSubTransportAdapter } from './adapters';
import { StaticAgentSpecRegistry, type AgentSpecRegistry } from './registries/agent-spec-registry';
import { POC_AGENT_SPEC } from './registries/poc-class-registry';
import { LocalFileStorage } from './storage/local-file-storage';
import { TenantRuntime } from './tenant-runtime';

export interface CentralServiceOptions {
  storage?: RuntimeStorage;
  transport?: RuntimeTransport;
  clock?: Clock;
  tenant?: TenantContext;
  requestContext?: RequestContext;
  agentSpecRegistry?: AgentSpecRegistry;
}

export class CentralService {
  private readonly clock: Clock;
  private readonly transport: RuntimeTransport;
  private readonly defaultTenantRuntime: TenantRuntime;
  private readonly requestContext: RequestContext;

  constructor(options: CentralServiceOptions = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.transport = options.transport ?? new WebPubSubTransportAdapter();
    const tenant = options.tenant ?? {
      tenantId: 'poc',
      storageRoot: '.runtime-poc/tenants/poc',
      webPubSubHub: 'agent-runtime-poc'
    };
    const storage = options.storage ?? new LocalFileStorage(tenant.storageRoot);
    this.defaultTenantRuntime = new TenantRuntime({
      tenant,
      storage,
      transport: this.transport,
      clock: this.clock,
      agentSpecRegistry: options.agentSpecRegistry ?? new StaticAgentSpecRegistry([POC_AGENT_SPEC])
    });
    this.requestContext = options.requestContext ?? {
      principal: {
        principalId: 'demo-user',
        type: 'user'
      },
      connectionId: 'demo-connection'
    };
  }

  async start(): Promise<void> {
    await this.transport.subscribe(CENTRAL_EVENTS_GROUP, (event) => this.handleCentralEvent(event));
  }

  async createSession(request: CreateSessionRequest): Promise<string> {
    return this.defaultTenantRuntime.createSession(this.requestContext, request);
  }

  async negotiateClientConnection(): Promise<{ url: string }> {
    return this.defaultTenantRuntime.negotiateClientConnection(this.requestContext);
  }

  async negotiateSidecarConnection(): Promise<{ url: string }> {
    return this.defaultTenantRuntime.negotiateSidecarConnection({
      principal: {
        principalId: 'demo-sidecar',
        type: 'service'
      },
      connectionId: 'demo-sidecar-connection'
    });
  }

  private async handleCentralEvent(event: RuntimeEvent): Promise<void> {
    if (event.type !== 'session.create.requested') {
      return;
    }

    const payload = this.parseCreateSessionRequestedPayload(event.payload);
    await this.createSession(payload);
  }

  private parseCreateSessionRequestedPayload(payload: unknown): CreateSessionRequest {
    if (!this.isCreateSessionRequestedPayload(payload)) {
      throw new Error('invalid session.create.requested payload');
    }
    return payload;
  }

  private isCreateSessionRequestedPayload(payload: unknown): payload is CreateSessionRequest {
    if (typeof payload !== 'object' || payload === null) {
      return false;
    }
    const candidate = payload as Partial<CreateSessionRequest>;
    return typeof candidate.agent?.agentSpecId === 'string'
      && typeof candidate.input?.initialMessage === 'string'
      && typeof candidate.input?.clientRequestId === 'string'
      && candidate.workspace?.source === 'empty';
  }
}