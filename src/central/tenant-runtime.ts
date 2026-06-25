import type { AgentSpecRegistry } from './registries/agent-spec-registry';
import type { Clock, RequestContext, RuntimeConnectionGrant, RuntimeEventTransport, RuntimeStorage, TenantConnectionIssuer, TenantContext, WorkerRegisterPayload } from '../shared';
import { AgentRuntimeEventController, ClientRuntimeEventController, TenantInboxController, WorkerRuntimeEventController } from './controllers';
import { AgentSpecAdmissionManager, EventLogManager, SessionAssignmentManager, SessionLifecycleManager, SessionLifecycleReconciler, SessionLeaseManager, SessionManager, WorkerManager, WorkerSelector } from './managers';

const WORKER_EXPIRY_SCAN_INTERVAL_MS = 5_000;
const SESSION_RECONCILE_INTERVAL_MS = 5_000;

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
  private readonly storage: RuntimeStorage;
  private readonly eventTransport: RuntimeEventTransport;
  private readonly connectionIssuer: TenantConnectionIssuer;
  private readonly tenantInboxController: TenantInboxController;
  private readonly workerManager: WorkerManager;
  private workerExpiryTimer: NodeJS.Timeout | undefined;
  private sessionReconcileTimer: NodeJS.Timeout | undefined;

  constructor(options: TenantRuntimeOptions) {
    this.tenant = options.tenant;
    this.storage = options.storage;
    this.eventTransport = options.eventTransport;
    this.connectionIssuer = options.connectionIssuer;
    const agentSpecAdmissionManager = new AgentSpecAdmissionManager(options.clock);
    const sessionLifecycleManager = new SessionLifecycleManager(options.storage, options.clock);
    const eventLogManager = new EventLogManager(options.storage, options.clock);
    const workerSelector = new WorkerSelector(() => Date.parse(options.clock.now()));
    const sessionLeaseManager = new SessionLeaseManager(options.storage);
    const sessionAssignmentManager = new SessionAssignmentManager(options.storage, options.clock, workerSelector, sessionLeaseManager);
    const sessionLifecycleReconciler = new SessionLifecycleReconciler(options.storage, options.clock, sessionLifecycleManager, eventLogManager, sessionAssignmentManager, options.eventTransport);
    const sessionManager = new SessionManager(
      options.tenant,
      options.storage,
      options.agentSpecRegistry,
      agentSpecAdmissionManager,
      sessionLifecycleManager,
      eventLogManager,
      sessionAssignmentManager,
      sessionLifecycleReconciler
    );
    this.workerManager = new WorkerManager(options.storage, options.clock, undefined, options.eventTransport);
    this.tenantInboxController = new TenantInboxController(
      options.tenant.tenantId,
      new WorkerRuntimeEventController(this.workerManager, sessionLifecycleReconciler, options.eventTransport),
      new AgentRuntimeEventController(options.storage, eventLogManager, sessionLifecycleManager, sessionLeaseManager, this.workerManager, sessionLifecycleReconciler, options.eventTransport),
      new ClientRuntimeEventController(sessionManager, options.eventTransport),
      options.eventTransport
    );
  }

  async start(): Promise<void> {
    await this.eventTransport.subscribe({ kind: 'tenant-inbox' }, (envelope) => this.tenantInboxController.handleRuntimeEvent(envelope.context, envelope.event));
    this.workerExpiryTimer = setInterval(() => {
      void this.expireWorkers().catch((error: unknown) => {
        console.error('worker expiry scan failed', error);
      });
    }, WORKER_EXPIRY_SCAN_INTERVAL_MS);
    this.workerExpiryTimer.unref?.();
    this.sessionReconcileTimer = setInterval(() => {
      void this.reconcileSessions().catch((error: unknown) => {
        console.error('session lifecycle reconcile failed', error);
      });
    }, SESSION_RECONCILE_INTERVAL_MS);
    this.sessionReconcileTimer.unref?.();
  }

  async negotiateClientConnection(context: RequestContext): Promise<RuntimeConnectionGrant> {
    if (!context.connectionId) {
      throw new Error('clientConnectionId is required for client negotiate');
    }
    const clientConnectionId = context.connectionId;
    const grant = await this.connectionIssuer.issueClientConnection({
      principal: { ...context.principal, connectionId: clientConnectionId },
      channels: [{ kind: 'tenant-inbox' }, { kind: 'client-inbox' }, { kind: 'client-private-inbox', clientConnectionId }]
    });
    return {
      ...grant,
      clientInbox: {},
      clientPrivateInbox: { clientConnectionId }
    };
  }

  async negotiateSidecarConnection(context: RequestContext, registration: WorkerRegisterPayload): Promise<RuntimeConnectionGrant> {
    const worker = await this.workerManager.register({ tenantId: this.tenant.tenantId, ...registration });
    const grant = await this.connectionIssuer.issueSidecarConnection({
      principal: context.principal,
      channels: [
        { kind: 'tenant-inbox' },
        { kind: 'worker-commands', workerId: worker.workerId }
      ]
    });
    return { ...grant, worker };
  }

  async expireWorkers(): Promise<void> {
    await this.workerManager.expireWorkers();
  }

  async reconcileSessions(): Promise<void> {
    await this.tenantInboxController.reconcileSessions();
  }

}