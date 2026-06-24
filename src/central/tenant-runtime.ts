import type { AgentSpecRegistry } from './registries/agent-spec-registry';
import type { Clock, RequestContext, RuntimeConnectionGrant, RuntimeEventTransport, RuntimeStorage, TenantConnectionIssuer, TenantContext } from '../shared';
import { ClientRuntimeEventController, TenantInboxController, WorkerRuntimeEventController } from './controllers';
import { AgentSpecAdmissionManager, EventLogManager, SessionAssignmentManager, SessionLifecycleManager, SessionManager, WorkerLeaseManager, WorkerManager, WorkerSelector } from './managers';

export interface TenantRuntimeOptions {
  tenant: TenantContext;
  storage: RuntimeStorage;
  eventTransport: RuntimeEventTransport;
  connectionIssuer: TenantConnectionIssuer;
  clock: Clock;
  agentSpecRegistry: AgentSpecRegistry;
}

export class TenantRuntime {
  private readonly tenant: TenantContext;
  private readonly eventTransport: RuntimeEventTransport;
  private readonly connectionIssuer: TenantConnectionIssuer;
  private readonly tenantInboxController: TenantInboxController;
  private readonly workerManager: WorkerManager;

  constructor(options: TenantRuntimeOptions) {
    this.tenant = options.tenant;
    this.eventTransport = options.eventTransport;
    this.connectionIssuer = options.connectionIssuer;
    const agentSpecAdmissionManager = new AgentSpecAdmissionManager(options.clock);
    const sessionLifecycleManager = new SessionLifecycleManager(options.storage, options.clock);
    const eventLogManager = new EventLogManager(options.storage, options.clock);
    const workerSelector = new WorkerSelector();
    const workerLeaseManager = new WorkerLeaseManager(options.storage);
    const sessionAssignmentManager = new SessionAssignmentManager(options.storage, options.clock, workerSelector, workerLeaseManager);
    const sessionManager = new SessionManager(
      options.tenant,
      options.storage,
      options.agentSpecRegistry,
      agentSpecAdmissionManager,
      sessionLifecycleManager,
      eventLogManager,
      sessionAssignmentManager
    );
    this.workerManager = new WorkerManager(options.storage, options.clock);
    this.tenantInboxController = new TenantInboxController(
      options.tenant.tenantId,
      new WorkerRuntimeEventController(this.workerManager),
      new ClientRuntimeEventController(sessionManager, options.eventTransport)
    );
  }

  async start(): Promise<void> {
    await this.eventTransport.subscribe({ kind: 'tenant-inbox' }, (envelope) => this.tenantInboxController.handleRuntimeEvent(envelope.context, envelope.event));
  }

  async negotiateClientConnection(context: RequestContext): Promise<RuntimeConnectionGrant> {
    const grant = await this.connectionIssuer.issueClientConnection({
      principal: context.principal,
      channels: [{ kind: 'tenant-inbox' }, { kind: 'client-inbox', principalId: context.principal.principalId }]
    });
    return {
      ...grant,
      clientInbox: {
        principalId: context.principal.principalId
      }
    };
  }

  async negotiateSidecarConnection(context: RequestContext): Promise<RuntimeConnectionGrant> {
    return this.connectionIssuer.issueSidecarConnection({
      principal: context.principal,
      channels: [{ kind: 'tenant-inbox' }]
    });
  }

  async expireWorkers(): Promise<void> {
    await this.workerManager.expireWorkers();
  }

}