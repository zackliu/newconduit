import type { AgentSpecRegistry } from './registries/agent-spec-registry';
import type { Clock, CreateSessionRequest, RequestContext, RuntimeStorage, RuntimeTransport, TenantContext } from '../shared';
import { CENTRAL_EVENTS_GROUP, sessionGroup } from '../shared/protocol/web-pubsub-events';
import { AgentSpecAdmissionController, EventLogController, SessionLifecycleController } from './controllers';

export interface TenantRuntimeOptions {
  tenant: TenantContext;
  storage: RuntimeStorage;
  transport: RuntimeTransport;
  clock: Clock;
  agentSpecRegistry: AgentSpecRegistry;
}

export class TenantRuntime {
  private readonly tenant: TenantContext;
  private readonly storage: RuntimeStorage;
  private readonly transport: RuntimeTransport;
  private readonly agentSpecRegistry: AgentSpecRegistry;
  private readonly agentSpecAdmissionController: AgentSpecAdmissionController;
  private readonly sessionLifecycleController: SessionLifecycleController;
  private readonly eventLogController: EventLogController;

  constructor(options: TenantRuntimeOptions) {
    this.tenant = options.tenant;
    this.storage = options.storage;
    this.transport = options.transport;
    this.agentSpecRegistry = options.agentSpecRegistry;
    this.agentSpecAdmissionController = new AgentSpecAdmissionController(options.clock);
    this.sessionLifecycleController = new SessionLifecycleController(options.storage, options.clock);
    this.eventLogController = new EventLogController(options.storage, options.clock);
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
    await this.transport.publish(sessionGroup(queuedSession.sessionId), event);
    return queuedSession.sessionId;
  }

  async negotiateClientConnection(context: RequestContext): Promise<{ url: string }> {
    return this.transport.negotiate(context.principal.principalId, [CENTRAL_EVENTS_GROUP]);
  }

  async negotiateSidecarConnection(context: RequestContext): Promise<{ url: string }> {
    return this.transport.negotiate(context.principal.principalId, [CENTRAL_EVENTS_GROUP]);
  }

  get tenantId(): string {
    return this.tenant.tenantId;
  }
}