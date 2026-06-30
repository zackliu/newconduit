import { SystemClock, type Clock, type RequestContext, type RuntimeConnectionGrant, type RuntimeEventTransport, type RuntimeStorage, type TenantConnectionIssuer, type TenantContext, type WorkerPoolRecord, type WorkerRegisterPayload } from '../shared';
import type { HostPoolAdapter, WorkerPoolManagerStatus } from './managers';
import { StaticAgentSpecRegistry, type AgentSpecRegistry } from './registries/agent-spec-registry';
import { POC_AGENT_SPEC, POC_DOTNET_AGENT_SPEC, POC_LOCAL_AGENT_SPEC } from './registries/poc-class-registry';
import { LocalFileStorage } from './storage/local-file-storage';
import { TenantRuntime } from './tenant-runtime';

export interface CentralServiceOptions {
  storage?: RuntimeStorage;
  eventTransport: RuntimeEventTransport;
  connectionIssuer: TenantConnectionIssuer;
  clock?: Clock;
  tenant?: TenantContext;
  agentSpecRegistry?: AgentSpecRegistry;
  workerPools?: WorkerPoolRecord[];
  hostPoolAdapters?: Record<string, HostPoolAdapter>;
}

export class CentralService {
  private readonly tenantRuntimes = new Map<string, TenantRuntime>();

  constructor(options: CentralServiceOptions) {
    const clock = options.clock ?? new SystemClock();
    const tenant = options.tenant ?? {
      tenantId: 'poc',
      storageRoot: '.runtime-poc/tenants/poc',
      webPubSubHub: 'agent-runtime-poc'
    };
    const storage = options.storage ?? new LocalFileStorage(tenant.storageRoot);
    const tenantRuntime = new TenantRuntime({
      tenant,
      storage,
      eventTransport: options.eventTransport,
      connectionIssuer: options.connectionIssuer,
      clock,
      agentSpecRegistry: options.agentSpecRegistry ?? new StaticAgentSpecRegistry([POC_AGENT_SPEC, POC_LOCAL_AGENT_SPEC, POC_DOTNET_AGENT_SPEC]),
      workerPools: options.workerPools,
      hostPoolAdapters: options.hostPoolAdapters
    });
    this.tenantRuntimes.set(tenant.tenantId, tenantRuntime);
  }

  async start(): Promise<void> {
    await Promise.all([...this.tenantRuntimes.values()].map((tenantRuntime) => tenantRuntime.start()));
  }

  async negotiateClientConnectionForTenant(tenantId: string | null, context: RequestContext): Promise<RuntimeConnectionGrant> {
    return this.resolveTenantRuntime(tenantId, 'client negotiate').negotiateClientConnection(context);
  }

  async negotiateSidecarConnectionForTenant(tenantId: string | null, context: RequestContext, registration: WorkerRegisterPayload): Promise<RuntimeConnectionGrant> {
    return this.resolveTenantRuntime(tenantId, 'sidecar negotiate').negotiateSidecarConnection(context, registration);
  }

  async reconcileSessionsForTenant(tenantId: string | null): Promise<void> {
    await this.resolveTenantRuntime(tenantId, 'session reconcile').reconcileSessions();
  }

  async describeWorkerPoolsForTenant(tenantId: string | null): Promise<WorkerPoolManagerStatus> {
    return await this.resolveTenantRuntime(tenantId, 'worker pool status').describeWorkerPools();
  }

  private resolveTenantRuntime(tenantId: string | null, operation: string): TenantRuntime {
    if (!tenantId) {
      throw new Error(`tenantId is required for ${operation}`);
    }
    const tenantRuntime = this.tenantRuntimes.get(tenantId);
    if (!tenantRuntime) {
      throw new Error(`tenant runtime ${tenantId} is not active`);
    }
    return tenantRuntime;
  }

}