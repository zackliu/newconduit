import type { AgentSpecRegistry } from './registries/agent-spec-registry';
import type { DelegateBindingIndex, ResolvedDelegateRegistry } from './registries/delegate-registry';
import type { Clock, RequestContext, RuntimeConnectionGrant, RuntimeEventTransport, RuntimeStorage, RuntimeSubscription, TenantConnectionIssuer, TenantContext, WorkerPoolRecord, WorkerRegisterPayload } from '../shared';
import { AgentRuntimeEventController, ClientRuntimeEventController, DelegationRuntimeEventController, TenantInboxController, WorkerRuntimeEventController } from './controllers';
import { AgentSpecAdmissionManager, CasePairingManager, DelegateAdmissionManager, DelegatedSessionManager, DelegationDispatcher, DelegationManager, EDGE_CASE_LABEL_KEY, EDGE_DEVICE_REF_LABEL_KEY, EventLogManager, FanoutManager, InteractionManager, SessionAssignmentManager, SessionLifecycleManager, SessionLifecycleReconciler, SessionLeaseManager, SessionManager, SessionPauseManager, SessionStartManager, WorkerManager, WorkerPoolManager, WorkerSelector, type HostPoolAdapter, type RedeemPairingInput, type RedeemPairingResult, type WorkerPoolManagerStatus } from './managers';
import { SnapshotManager } from './persistence';

const SESSION_RECONCILE_INTERVAL_MS = 5_000;

export interface TenantRuntimeOptions {
  tenant: TenantContext;
  storage: RuntimeStorage;
  eventTransport: RuntimeEventTransport;
  connectionIssuer: TenantConnectionIssuer;
  clock: Clock;
  agentSpecRegistry: AgentSpecRegistry;
  delegation?: {
    resolvedDelegateRegistry: ResolvedDelegateRegistry;
    delegateBindingIndex: DelegateBindingIndex;
    delegateAdmissionManager: DelegateAdmissionManager;
  };
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
  private readonly casePairingManager: CasePairingManager;
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
    const agentSpecAdmissionManager = new AgentSpecAdmissionManager(options.clock, (spec) => {
      if (!options.delegation) {
        return [];
      }
      return spec.delegateRefs.asCaller.map((delegateId) => options.delegation!.delegateAdmissionManager.runtimeTool(
        options.delegation!.resolvedDelegateRegistry.resolve(delegateId)
      ));
    });
    this.casePairingManager = new CasePairingManager(options.tenant.tenantId, options.storage, options.clock);
    // The authoritative device-binding revocation: whenever a session first crosses into a terminal status — from any
    // path, including a case that never spawned a delegation — revoke that case's device bindings so a lingering edge
    // credential can no longer register/route. Best-effort and idempotent; the terminal-case guard in
    // resolveEdgeBinding is the correctness backstop that closes the window before this persists.
    const sessionLifecycleManager = new SessionLifecycleManager(options.storage, options.clock, async (session) => {
      try {
        await this.casePairingManager.revokeCase(session.sessionId);
      } catch (error: unknown) {
        console.error(`case-binding revocation for terminal session ${session.sessionId} failed`, error);
      }
    });
    const eventLogManager = new EventLogManager(options.storage, options.clock);
    const workerSelector = new WorkerSelector(() => Date.parse(options.clock.now()));
    const sessionLeaseManager = new SessionLeaseManager(options.storage);
    const snapshotManager = new SnapshotManager(options.storage, options.clock);
    const sessionPauseManager = new SessionPauseManager(options.storage, sessionLifecycleManager, eventLogManager, snapshotManager);
    const sessionAssignmentManager = new SessionAssignmentManager(options.storage, options.clock, workerSelector, sessionLeaseManager, snapshotManager);
    this.workerManager = new WorkerManager(options.storage, options.clock, undefined, options.eventTransport);
    this.workerPoolManager = options.workerPools && options.workerPools.length > 0
      ? new WorkerPoolManager(options.storage, options.clock, this.workerManager, options.workerPools, options.hostPoolAdapters ?? {}, options.controllerEpoch)
      : undefined;
    const sessionLifecycleReconciler = new SessionLifecycleReconciler(options.storage, options.clock, sessionLifecycleManager, eventLogManager, sessionAssignmentManager, sessionPauseManager, options.eventTransport, this.workerManager, this.workerPoolManager);
    this.sessionLifecycleReconciler = sessionLifecycleReconciler;
    const sessionStartManager = new SessionStartManager(sessionLifecycleManager, eventLogManager, sessionAssignmentManager);
    const sessionManager = new SessionManager(
      options.tenant,
      options.storage,
      options.agentSpecRegistry,
      agentSpecAdmissionManager,
      sessionLifecycleManager,
      eventLogManager,
      sessionStartManager,
      sessionPauseManager,
      sessionLifecycleReconciler
    );
    const interactionManager = new InteractionManager(
      options.tenant.tenantId,
      options.storage,
      options.clock,
      eventLogManager,
      sessionLifecycleManager,
      sessionLeaseManager,
      options.eventTransport
    );
    const delegationManager = options.delegation ? new DelegationManager(
      options.tenant.tenantId,
      options.storage,
      options.clock,
      options.delegation.resolvedDelegateRegistry,
      options.delegation.delegateBindingIndex,
      options.delegation.delegateAdmissionManager,
      agentSpecAdmissionManager,
      sessionLifecycleManager
    ) : undefined;
    const delegationDispatcher = delegationManager ? new DelegationDispatcher(
      options.storage,
      options.clock,
      new DelegatedSessionManager(options.storage, eventLogManager, sessionLifecycleManager, sessionStartManager)
    ) : undefined;
    const delegationRuntimeEventController = delegationManager && delegationDispatcher
      ? new DelegationRuntimeEventController(options.storage, sessionLeaseManager, delegationManager, delegationDispatcher, sessionManager, options.eventTransport, new FanoutManager(options.tenant.tenantId, options.storage, options.clock))
      : undefined;
    this.tenantInboxController = new TenantInboxController(
      options.tenant.tenantId,
      new WorkerRuntimeEventController(this.workerManager, sessionLifecycleReconciler),
      new AgentRuntimeEventController(options.storage, eventLogManager, sessionLifecycleManager, sessionLeaseManager, this.workerManager, sessionLifecycleReconciler, snapshotManager, interactionManager, options.eventTransport),
      delegationRuntimeEventController,
      new ClientRuntimeEventController(sessionManager, interactionManager, this.casePairingManager, options.eventTransport),
      interactionManager,
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
    const labels = await this.resolveWorkerLabels(registration);
    const worker = await this.workerManager.register({ tenantId: this.tenant.tenantId, ...registration, labels });
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

  /**
   * Redeem a one-time pairing invite into a durable device binding. This is the edge HTTP enrollment path (peer of
   * negotiate): it runs after an explicit user action on the device and returns the binding credential exactly once.
   */
  async redeemPairingInvite(input: RedeemPairingInput): Promise<RedeemPairingResult> {
    return this.casePairingManager.redeemPairingInvite(input);
  }

  /**
   * Compute the authoritative worker labels for a registration. The `case`/`deviceRef` label keys are Central-owned:
   * any client-supplied value for them is stripped, and they are re-minted only from a validated edge binding. A
   * worker without an edge binding therefore cannot self-declare case/device routing labels — closing the
   * self-asserted-label hole while leaving ordinary sidecars unaffected.
   */
  private async resolveWorkerLabels(registration: WorkerRegisterPayload): Promise<Record<string, string>> {
    const sanitized = { ...registration.labels };
    delete sanitized[EDGE_CASE_LABEL_KEY];
    delete sanitized[EDGE_DEVICE_REF_LABEL_KEY];
    if (!registration.edgeBinding) {
      return sanitized;
    }
    const resolved = await this.casePairingManager.resolveEdgeBinding(registration.edgeBinding);
    return { ...sanitized, ...resolved.mintedLabels };
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