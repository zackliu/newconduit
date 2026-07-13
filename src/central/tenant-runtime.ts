import type { AgentSpecRegistry } from './registries/agent-spec-registry';
import type { Clock, RequestContext, RuntimeConnectionGrant, RuntimeEventTransport, RuntimeStorage, RuntimeSubscription, TenantConnectionIssuer, TenantContext, WorkerPoolRecord, WorkerRegisterPayload } from '../shared';
import { AgentRuntimeEventController, ClientRuntimeEventController, TenantInboxController, WorkerRuntimeEventController } from './controllers';
import { AgentSpecAdmissionManager, EventLogManager, SessionAssignmentManager, SessionLifecycleManager, SessionLifecycleReconciler, SessionLeaseManager, SessionManager, WorkerManager, WorkerPoolManager, WorkerSelector, type HostPoolAdapter, type WorkerPoolManagerStatus } from './managers';
import { SnapshotManager } from './persistence';

const SESSION_RECONCILE_INTERVAL_MS = 5_000;

export interface TenantRuntimeOptions {
  tenant: TenantContext;
  storage: RuntimeStorage;
  eventTransport: RuntimeEventTransport;
  connectionIssuer: TenantConnectionIssuer;
  clock: Clock;
  agentSpecRegistry: AgentSpecRegistry;
  workerPools?: WorkerPoolRecord[];
  hostPoolAdapters?: Record<string, HostPoolAdapter>;
  controllerEpoch?: string;
}

export class TenantRuntime {
  private readonly tenant: TenantContext;
  private readonly storage: RuntimeStorage;
  private readonly eventTransport: RuntimeEventTransport;
  private readonly connectionIssuer: TenantConnectionIssuer;
  private readonly tenantInboxController: TenantInboxController;
  private readonly workerManager: WorkerManager;
  private readonly workerPoolManager: WorkerPoolManager | undefined;
  private readonly sessionLifecycleReconciler: SessionLifecycleReconciler;
  private readonly agentSpecRegistry: AgentSpecRegistry;
  private tenantInboxSubscription: RuntimeSubscription | undefined;
  private sessionReconcileTimer: NodeJS.Timeout | undefined;

  constructor(options: TenantRuntimeOptions) {
    this.tenant = options.tenant;
    this.storage = options.storage;
    this.eventTransport = options.eventTransport;
    this.connectionIssuer = options.connectionIssuer;
    this.agentSpecRegistry = options.agentSpecRegistry;
    const agentSpecAdmissionManager = new AgentSpecAdmissionManager(options.clock);
    const sessionLifecycleManager = new SessionLifecycleManager(options.storage, options.clock);
    const eventLogManager = new EventLogManager(options.storage, options.clock);
    const workerSelector = new WorkerSelector(() => Date.parse(options.clock.now()));
    const sessionLeaseManager = new SessionLeaseManager(options.storage);
    const snapshotManager = new SnapshotManager(options.storage, options.clock);
    const sessionAssignmentManager = new SessionAssignmentManager(options.storage, options.clock, workerSelector, sessionLeaseManager, snapshotManager);
    this.workerManager = new WorkerManager(options.storage, options.clock, undefined, options.eventTransport);
    this.workerPoolManager = options.workerPools && options.workerPools.length > 0
      ? new WorkerPoolManager(options.storage, options.clock, this.workerManager, options.workerPools, options.hostPoolAdapters ?? {}, options.controllerEpoch)
      : undefined;
    const sessionLifecycleReconciler = new SessionLifecycleReconciler(options.storage, options.clock, sessionLifecycleManager, eventLogManager, sessionAssignmentManager, snapshotManager, options.eventTransport, this.workerManager, this.workerPoolManager);
    this.sessionLifecycleReconciler = sessionLifecycleReconciler;
    const sessionManager = new SessionManager(
      options.tenant,
      options.storage,
      options.agentSpecRegistry,
      agentSpecAdmissionManager,
      sessionLifecycleManager,
      eventLogManager,
      sessionAssignmentManager,
      snapshotManager,
      sessionLifecycleReconciler
    );
    this.tenantInboxController = new TenantInboxController(
      options.tenant.tenantId,
      new WorkerRuntimeEventController(this.workerManager, sessionLifecycleReconciler),
      new AgentRuntimeEventController(options.storage, eventLogManager, sessionLifecycleManager, sessionLeaseManager, this.workerManager, sessionLifecycleReconciler, snapshotManager, options.eventTransport),
      new ClientRuntimeEventController(sessionManager, options.eventTransport),
      options.eventTransport
    );
  }

  async start(): Promise<void> {
    this.tenantInboxSubscription = await this.eventTransport.subscribe({ kind: 'tenant-inbox' }, (envelope) => this.tenantInboxController.handleRuntimeEvent(envelope.context, envelope.event));
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
      principal: {
        principalId: worker.workerId,
        type: 'service',
        connectionId: worker.workerId
      },
      channels: [
        { kind: 'tenant-inbox' },
        { kind: 'worker-commands', workerId: worker.workerId }
      ]
    });
    return { ...grant, worker };
  }

  async reconcileSessions(): Promise<void> {
    await this.tenantInboxController.reconcileSessions();
  }

  async stop(): Promise<void> {
    if (this.sessionReconcileTimer) {
      clearInterval(this.sessionReconcileTimer);
      this.sessionReconcileTimer = undefined;
    }
    await this.sessionLifecycleReconciler.drain();
    await this.tenantInboxSubscription?.close();
    this.tenantInboxSubscription = undefined;
    await this.sessionLifecycleReconciler.drain();
    await this.workerPoolManager?.releaseControl();
  }

  async describeWorkerPools(): Promise<WorkerPoolManagerStatus> {
    const base = await (this.workerPoolManager?.describe() ?? Promise.resolve({
      workerPools: [],
      hostPoolInstances: await this.storage.readHostPoolInstances(),
      workers: await this.storage.readWorkers(),
      agentSpecs: []
    }));
    return { ...base, agentSpecs: this.agentSpecRegistry.list() };
  }

}