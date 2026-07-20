import type { Clock, RuntimeEvent, RuntimeEventTransport, RuntimeStorage, SessionPauseCommandPayload, SessionPausedPayload, SessionRecord, WorkerRecord } from '../../../shared';
import { EventLogManager } from './event-log-manager';
import { SessionAssignmentManager, type WorkerCommandOutput } from './session-assignment-manager';
import { SessionLifecycleManager } from './session-lifecycle-manager';
import { SessionPauseManager } from './session-pause-manager';
import { WorkerPoolManager } from '../worker/worker-pool-manager';
import { WorkerManager } from '../worker/worker-manager';

/**
 * Reconciles durable session lifecycle facts that are independent from any client connection.
 */
export class SessionLifecycleReconciler {
  private reconcileTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: RuntimeStorage,
    private readonly clock: Clock,
    private readonly sessionLifecycleManager: SessionLifecycleManager,
    private readonly eventLogManager: EventLogManager,
    private readonly sessionAssignmentManager: SessionAssignmentManager,
    private readonly sessionPauseManager: SessionPauseManager,
    private readonly eventTransport: RuntimeEventTransport,
    private readonly workerManager: WorkerManager,
    private readonly workerPoolManager?: WorkerPoolManager
  ) {}

  reconcile(): Promise<void> {
    const run = this.reconcileTail.then(() => this.reconcileOnce());
    this.reconcileTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async drain(): Promise<void> {
    for (;;) {
      const tail = this.reconcileTail;
      await tail;
      if (tail === this.reconcileTail) {
        return;
      }
    }
  }

  private async reconcileOnce(): Promise<void> {
    // Establish this controller incarnation's report expectations before applying ordinary Worker TTL expiry.
    // A surviving sidecar gets the full instance report window to prove itself with a fresh heartbeat.
    await this.workerPoolManager?.reconcile();
    await this.workerManager.expireWorkers();
    await this.workerPoolManager?.reconcile();
    const workerCommands: Array<WorkerCommandOutput<SessionPauseCommandPayload> | WorkerCommandOutput> = [];
    const sessions = await this.storage.readSessions();
    const sessionsWithPendingDelegationWork = await this.sessionsWithPendingDelegationWork();
    for (const session of sessions) {
      if (session.status === 'queued') {
        const command = await this.reconcileQueuedSession(session, sessionsWithPendingDelegationWork.has(session.sessionId));
        if (command) {
          workerCommands.push(command);
        }
        continue;
      }
      if (session.status === 'running' && await this.isIdle(session, sessionsWithPendingDelegationWork.has(session.sessionId))) {
        const command = await this.requestIdlePause(session);
        if (command) {
          workerCommands.push(command);
        }
        continue;
      }
      if (session.status === 'pausing') {
        const command = await this.recoverPause(session);
        if (command) {
          workerCommands.push(command);
        }
      }
    }
    await this.workerPoolManager?.reconcile();
    for (const command of workerCommands) {
      await this.eventTransport.publish({ kind: 'worker-commands', workerId: command.workerId }, command.event);
    }
  }

  private async reconcileQueuedSession(session: SessionRecord, hasPendingDelegationWork: boolean): Promise<WorkerCommandOutput | undefined> {
    if (await this.isIdle(session, hasPendingDelegationWork)) {
      await this.pauseQueuedSession(session);
      return undefined;
    }
    const assignment = await this.sessionAssignmentManager.assignReadyWorker(session);
    if (!assignment.workerCommand) {
      return undefined;
    }
    await this.publishSessionStatus(assignment.session, 'starting');
    return assignment.workerCommand;
  }

  private async pauseQueuedSession(session: SessionRecord): Promise<void> {
    const event = await this.eventLogManager.append<SessionPausedPayload>({
      type: 'session.paused',
      actor: 'central',
      payload: { reason: 'idle_timeout' },
      sequence: session.eventCursor + 1,
      sessionId: session.sessionId
    });
    const paused = await this.sessionLifecycleManager.pauseAfterEvent(session, event.sequence, event.timestamp, 'idle_timeout');
    await this.eventTransport.publish({ kind: 'session-events', sessionId: session.sessionId }, event);
    await this.publishSessionStatus(paused, 'paused', 'idle_timeout');
  }

  private async requestIdlePause(session: SessionRecord): Promise<WorkerCommandOutput<SessionPauseCommandPayload> | undefined> {
    if (!session.currentWorkerId || !session.sessionLeaseId) {
      return undefined;
    }
    const outcome = await this.sessionPauseManager.request(session, 'central', 'idle_timeout');
    await this.eventTransport.publish({ kind: 'session-events', sessionId: session.sessionId }, outcome.pauseRequestedEvent);
    await this.publishSessionStatus(outcome.session, 'pausing', 'idle_timeout');
    return outcome.workerCommand;
  }

  private async recoverPause(session: SessionRecord): Promise<WorkerCommandOutput<SessionPauseCommandPayload> | undefined> {
    const worker = session.currentWorkerId ? await this.storage.readWorker(session.currentWorkerId) : undefined;
    const workerState = worker?.lifecycleState ?? 'missing';
    if (!this.canContinuePause(session, worker)) {
      await this.workerManager.failSessionForWorkerLoss(session, workerState);
      return undefined;
    }
    const command = await this.sessionPauseManager.recover(session);
    if (command) {
      return command;
    }
    await this.workerManager.failSessionForWorkerLoss(session, workerState);
    return undefined;
  }

  private canContinuePause(session: SessionRecord, worker: WorkerRecord | undefined): boolean {
    return Boolean(session.currentWorkerId
      && session.sessionLeaseId
      && worker
      && worker.workerId === session.currentWorkerId
      && worker.lifecycleState === 'active'
      && !worker.conditions.includes('disconnected')
      && Date.parse(worker.expiresAt) > Date.parse(this.clock.now()));
  }

  private async isIdle(session: SessionRecord, hasPendingDelegationWork: boolean): Promise<boolean> {
    const hasOpenInteraction = (await this.storage.readInteractionsBySession(session.sessionId)).some((interaction) => interaction.state === 'open');
    return !hasPendingDelegationWork
      && !hasOpenInteraction
      && Date.parse(this.clock.now()) - Date.parse(session.lastEventUpdatedAt) >= session.resolvedAgentSpec.idlePauseTimeoutMs;
  }

  private async sessionsWithPendingDelegationWork(): Promise<Set<string>> {
    const sessionIds = new Set<string>();
    for (const delegation of await this.storage.readDelegations()) {
      if (!delegation.calls.some((call) => call.status === 'queued' || call.status === 'active' || call.status === 'cancel_requested')) {
        continue;
      }
      sessionIds.add(delegation.parentSessionId);
      sessionIds.add(delegation.childSessionId);
    }
    return sessionIds;
  }

  private async publishSessionStatus(session: SessionRecord, status: SessionRecord['status'], reason?: string): Promise<void> {
    await this.eventTransport.publish({ kind: 'client-inbox' }, {
      eventId: crypto.randomUUID(),
      sessionId: session.sessionId,
      sequence: 0,
      type: 'session.status.updated',
      timestamp: this.clock.now(),
      actor: 'central',
      payload: {
        sessionId: session.sessionId,
        status,
        reason
      }
    } satisfies RuntimeEvent);
  }
}