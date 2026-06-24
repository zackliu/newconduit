import { SystemClock, type Clock, type RequestContext, type RuntimeConnectionGrant, type RuntimeEventTransport, type RuntimeStorage, type TenantConnectionIssuer, type TenantContext } from '../shared';
import { StaticAgentSpecRegistry, type AgentSpecRegistry } from './registries/agent-spec-registry';
import { POC_AGENT_SPEC } from './registries/poc-class-registry';
import { LocalFileStorage } from './storage/local-file-storage';
import { TenantRuntime } from './tenant-runtime';

export interface CentralServiceOptions {
  storage?: RuntimeStorage;
  eventTransport: RuntimeEventTransport;
  connectionIssuer: TenantConnectionIssuer;
  clock?: Clock;
  tenant?: TenantContext;
  agentSpecRegistry?: AgentSpecRegistry;
}

export class CentralService {
  private readonly clock: Clock;
  private readonly defaultTenantRuntime: TenantRuntime;

  constructor(options: CentralServiceOptions) {
    this.clock = options.clock ?? new SystemClock();
    const tenant = options.tenant ?? {
      tenantId: 'poc',
      storageRoot: '.runtime-poc/tenants/poc',
      webPubSubHub: 'agent-runtime-poc'
    };
    const storage = options.storage ?? new LocalFileStorage(tenant.storageRoot);
    this.defaultTenantRuntime = new TenantRuntime({
      tenant,
      storage,
      eventTransport: options.eventTransport,
      connectionIssuer: options.connectionIssuer,
      clock: this.clock,
      agentSpecRegistry: options.agentSpecRegistry ?? new StaticAgentSpecRegistry([POC_AGENT_SPEC])
    });
  }

  async start(): Promise<void> {
    await this.defaultTenantRuntime.start();
  }

  async negotiateClientConnection(context: RequestContext): Promise<RuntimeConnectionGrant> {
    return this.defaultTenantRuntime.negotiateClientConnection(context);
  }

  async negotiateSidecarConnection(context: RequestContext): Promise<RuntimeConnectionGrant> {
    return this.defaultTenantRuntime.negotiateSidecarConnection(context);
  }

}