import type { AgentSpecRegistry } from './registries/agent-spec-registry';
import type { Clock, CreateSessionRequest, RequestContext, RuntimeConnectionGrant, RuntimeEvent, RuntimeEventTransport, RuntimeStorage, TenantConnectionIssuer, TenantContext } from '../shared';
import { AgentSpecAdmissionController, EventLogController, SessionLifecycleController, WorkerRegistryController } from './controllers';

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
  private readonly agentSpecRegistry: AgentSpecRegistry;
  private readonly agentSpecAdmissionController: AgentSpecAdmissionController;
  private readonly sessionLifecycleController: SessionLifecycleController;
  private readonly eventLogController: EventLogController;
  private readonly workerRegistryController: WorkerRegistryController;

  constructor(options: TenantRuntimeOptions) {
    this.tenant = options.tenant;
    this.storage = options.storage;
    this.eventTransport = options.eventTransport;
    this.connectionIssuer = options.connectionIssuer;
    this.agentSpecRegistry = options.agentSpecRegistry;
    this.agentSpecAdmissionController = new AgentSpecAdmissionController(options.clock);
    this.sessionLifecycleController = new SessionLifecycleController(options.storage, options.clock);
    this.eventLogController = new EventLogController(options.storage, options.clock);
    this.workerRegistryController = new WorkerRegistryController(options.storage, options.clock);
  }

  async createSession(context: RequestContext, request: CreateSessionRequest): Promise<string> {
    const agentSpec = await this.agentSpecRegistry.resolve(request.agent);
    const resolvedAgentSpec = this.agentSpecAdmissionController.resolve(agentSpec);
    const session = await this.sessionLifecycleController.create({
      tenantId: this.tenant.tenantId,
      owner: context.principal.principalId,
      resolvedAgentSpec,
      workspaceRef: `docker-volume:${crypto.randomUUID()}`
    });
    const event = await this.eventLogController.append({
      type: 'session.created',
      actor: 'central',
      payload: {
        initialMessage: request.input.initialMessage,
        clientRequestId: request.input.clientRequestId,
        workspace: request.workspace,
        requestedBy: context.principal.principalId
      },
      sequence: 1,
      sessionId: session.sessionId
    });
    const queuedSession = await this.sessionLifecycleController.transition({ ...session, eventCursor: event.sequence }, 'queued', 'waiting-for-worker');
    await this.eventTransport.publish({ kind: 'session-events', sessionId: queuedSession.sessionId }, event);
    return queuedSession.sessionId;
  }

  async start(): Promise<void> {
    await this.eventTransport.subscribe({ kind: 'tenant-inbox' }, (envelope) => this.handleRuntimeEvent(envelope.context, envelope.event));
  }

  async negotiateClientConnection(context: RequestContext): Promise<RuntimeConnectionGrant> {
    return this.connectionIssuer.issueClientConnection({
      principal: context.principal,
      channels: [{ kind: 'tenant-inbox' }]
    });
  }

  async negotiateSidecarConnection(context: RequestContext): Promise<RuntimeConnectionGrant> {
    return this.connectionIssuer.issueSidecarConnection({
      principal: context.principal,
      channels: [{ kind: 'tenant-inbox' }]
    });
  }

  async expireWorkers(): Promise<void> {
    await this.workerRegistryController.expireWorkers();
  }

  private async handleRuntimeEvent(context: RequestContext, event: RuntimeEvent): Promise<void> {
    if (await this.workerRegistryController.handleRuntimeEvent(this.tenant.tenantId, event)) {
      return;
    }

    switch (event.type) {
      case 'session.create.requested': {
        const payload = this.parseCreateSessionRequestedPayload(event.payload);
        await this.createSession(context, payload);
        return;
      }
      default:
        return;
    }
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