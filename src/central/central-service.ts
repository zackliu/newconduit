import { SystemClock, type Clock, type RequestContext, type RuntimeConnectionGrant, type RuntimeEventTransport, type RuntimeStorage, type TenantConnectionIssuer, type TenantContext, type WorkerPoolRecord, type WorkerRegisterPayload } from '../shared';
import type { HostPoolAdapter, RedeemPairingInput, RedeemPairingResult, WorkerPoolManagerStatus } from './managers';
import type { AgentSpecRegistry } from './registries/agent-spec-registry';
import type { DelegateBindingIndex, ResolvedDelegateRegistry } from './registries/delegate-registry';
import type { DelegateAdmissionManager } from './managers';
import { FileConfigStore } from './config/file-config-store';
import { loadTenantConfigGeneration } from './config/tenant-config-generation';
import { LocalFileStorage } from './storage/local-file-storage';
import { TenantRuntime } from './tenant-runtime';

export interface CentralServiceOptions {
  storage?: RuntimeStorage;
  eventTransport: RuntimeEventTransport;
  connectionIssuer: TenantConnectionIssuer;
  clock?: Clock;
  tenant?: TenantContext;
  agentSpecRegistry?: AgentSpecRegistry;
  delegation?: {
    resolvedDelegateRegistry: ResolvedDelegateRegistry;
    delegateBindingIndex: DelegateBindingIndex;
    delegateAdmissionManager: DelegateAdmissionManager;
  };
  workerPools?: WorkerPoolRecord[];
  hostPoolAdapters?: Record<string, HostPoolAdapter>;
  controllerEpoch?: string;
}

export class CentralService {
  private readonly tenantRuntimes = new Map<string, TenantRuntime>();

  constructor(options: CentralServiceOptions) {
    const defaultGeneration = options.agentSpecRegistry ? undefined : loadTenantConfigGeneration(new FileConfigStore());
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
      agentSpecRegistry: options.agentSpecRegistry ?? defaultGeneration!.agentSpecRegistry,
      delegation: options.delegation ?? defaultGeneration?.delegation,
      workerPools: options.workerPools,
      hostPoolAdapters: options.hostPoolAdapters,
      controllerEpoch: options.controllerEpoch
    });
    this.tenantRuntimes.set(tenant.tenantId, tenantRuntime);
  }

  async start(): Promise<void> {
    await Promise.all([...this.tenantRuntimes.values()].map((tenantRuntime) => tenantRuntime.start()));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.tenantRuntimes.values()].map((tenantRuntime) => tenantRuntime.stop()));
  }

  async negotiateClientConnectionForTenant(tenantId: string | null, context: RequestContext): Promise<RuntimeConnectionGrant> {
    return this.resolveTenantRuntime(tenantId, 'client negotiate').negotiateClientConnection(context);
  }

  async negotiateSidecarConnectionForTenant(tenantId: string | null, context: RequestContext, registration: WorkerRegisterPayload): Promise<RuntimeConnectionGrant> {
    return this.resolveTenantRuntime(tenantId, 'sidecar negotiate').negotiateSidecarConnection(context, registration);
  }

  async redeemPairingInviteForTenant(tenantId: string | null, context: RequestContext, input: RedeemPairingInput): Promise<RedeemPairingResult> {
    return this.resolveTenantRuntime(tenantId, 'pairing redeem').redeemPairingInvite(input);
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