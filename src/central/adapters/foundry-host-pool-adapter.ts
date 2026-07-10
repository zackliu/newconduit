import { DefaultAzureCredential, type AccessToken, type TokenCredential } from '@azure/identity';
import type { HostPoolAdapter, HostPoolScaleInInput, HostPoolScaleOutInput, HostPoolScaleOutResult } from '../managers';

const TOKEN_SCOPE = 'https://ai.azure.com/.default';
const API_VERSION = 'v1';
const FOUNDRY_FEATURES = 'HostedAgents=V1Preview';
const RECONNECT_BACKOFF_MS = 2_000;
const TOKEN_REFRESH_SKEW_MS = 60_000;

type FetchLike = typeof fetch;

export interface FoundryHostPoolAdapterOptions {
  projectEndpoint: string;
  agentName: string;
  workerType: string;
  credential?: TokenCredential;
  fetchImpl?: FetchLike;
}

interface LivenessHandle {
  sessionId: string;
  abort: AbortController;
  closed: boolean;
  loop?: Promise<void>;
}

/**
 * Provisions Foundry-hosted sidecar workers. Foundry owns the container lifecycle (request-driven, idle
 * scale-to-zero), so this adapter keeps a worker alive by holding one long `/invocations` request open per
 * instance: opening it boots the container (the in-container sidecar reads the boot payload and reverse-
 * registers over Web PubSub like any other Worker), and holding it suppresses the idle reap.
 *
 * The client controls the Foundry session id via the `agent_session_id` query parameter (a client id sent as a
 * request header is ignored by the platform). The id is the durable sandbox handle: for a session-pinned (no-reuse)
 * instance it is our session's stable `workspaceRef`, so a resume — a fresh instance carrying the same `workspaceRef`
 * — re-invokes the same session and finds the workspace intact. A dropped connection reconnects with the same id and
 * reaches the same sandbox.
 *
 * Worker lifecycle (is the sidecar running) and the durable Foundry session (the sandbox) are separate concerns.
 * Aborting the held request only closes central's connection; the Foundry container stays warm (idle-reaped ~15 min
 * later) with the now-orphaned sidecar still registered under the old worker. So both `scaleOut` and `scaleIn`
 * drive the session's compute deterministically via the platform stop/delete APIs rather than relying on Foundry's
 * idle reap: reap stops the compute so the next boot is clean, and boot normalizes any prior state to a fresh
 * container whose sidecar registers under the current instance id.
 *
 * `scaleOut`/`scaleIn` are the generic HostPoolAdapter contract; all Foundry specifics stay inside here, so
 * central never branches on the adapter kind. The command channel is Web PubSub inside the daemon; this HTTP
 * surface only carries boot + keepalive (see the confirmed data-plane API in the spec appendix).
 */
export class FoundryHostPoolAdapter implements HostPoolAdapter {
  static readonly classId = 'foundry';

  private readonly projectEndpoint: string;
  private readonly agentName: string;
  private readonly workerType: string;
  private readonly credential: TokenCredential;
  private readonly fetchImpl: FetchLike;
  private readonly liveness = new Map<string, LivenessHandle>();
  private cachedToken: AccessToken | null = null;

  constructor(options: FoundryHostPoolAdapterOptions) {
    this.projectEndpoint = options.projectEndpoint.replace(/\/+$/, '');
    this.agentName = options.agentName;
    this.workerType = options.workerType;
    this.credential = options.credential ?? new DefaultAzureCredential();
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async scaleOut(input: HostPoolScaleOutInput): Promise<HostPoolScaleOutResult> {
    const sessionId = this.sessionIdFor(input.instance);
    // Normalize the durable session to a clean boot state before invoking. The session may be not-exist (first
    // scale-out), inactive (stopped by a prior reap — the normal resume case), or still-active with a stale
    // container from an earlier generation (e.g. central restarted and lost its liveness handle). Stopping first
    // collapses all three to "no live compute", so the invocation always cold-boots a fresh container whose sidecar
    // reads THIS instance's boot payload and registers under the new instance id (a warm container would keep its
    // boot-once sidecar registered under the previous instance id and the new instance would never correlate).
    // Best-effort: a stop on a not-exist/already-stopped session is a harmless no-op.
    await this.stopSession(sessionId);
    const handle: LivenessHandle = { sessionId, abort: new AbortController(), closed: false };
    this.liveness.set(input.instance.instanceId, handle);
    const bootPayload = this.buildBootPayload(input);
    // Fire-and-forget: the held liveness request is what boots and keeps the sandbox alive; scaleOut returns the
    // client-chosen session id immediately so the WorkerPool reconcile keeps the instance pending until the
    // sidecar reverse-registers.
    handle.loop = this.runLivenessLoop(handle, bootPayload);
    return { containerId: sessionId };
  }

  async scaleIn(input: HostPoolScaleInInput): Promise<void> {
    const handle = this.liveness.get(input.instance.instanceId);
    const sessionId = handle?.sessionId ?? input.instance.containerId ?? this.sessionIdFor(input.instance);
    if (handle) {
      handle.closed = true;
      handle.abort.abort();
      this.liveness.delete(input.instance.instanceId);
      // Wait for the keepalive loop to stop before deciding, so a reconnect can't re-open the released request.
      await handle.loop;
    }
    // Aborting the held request above only closes central's connection; the Foundry container stays warm until its
    // own ~15 min idle reap. Deterministically stop the compute so the session lands in a known state immediately:
    // `retain` (bound session still alive, e.g. paused) stops compute but keeps the session record + $HOME so a
    // resume re-invokes the same sandbox with the workspace intact; `release` (session ended) deletes it outright.
    if (input.durableAction === 'retain') {
      await this.stopSession(sessionId);
      return;
    }
    await this.deleteSession(sessionId);
  }

  private async runLivenessLoop(handle: LivenessHandle, bootPayload: Record<string, unknown>): Promise<void> {
    while (!handle.closed) {
      try {
        await this.holdLivenessInvocation(handle, bootPayload);
      } catch (error) {
        if (handle.closed) {
          return;
        }
        console.error(`foundry liveness for session ${handle.sessionId} dropped; reconnecting`, error);
      }
      if (handle.closed) {
        return;
      }
      // Reconnect with the same agent_session_id -> same session/sandbox. Small backoff avoids a tight loop.
      handle.abort = new AbortController();
      await delay(RECONNECT_BACKOFF_MS);
    }
  }

  private async holdLivenessInvocation(handle: LivenessHandle, bootPayload: Record<string, unknown>): Promise<void> {
    // The client controls the session id through the agent_session_id query parameter; reusing the same id
    // reconnects to the same session/sandbox (a session id sent as a request header is ignored by the platform).
    const url = `${this.base()}/endpoint/protocols/invocations?api-version=${API_VERSION}&agent_session_id=${encodeURIComponent(handle.sessionId)}`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.token()}`,
        'content-type': 'application/json',
        'foundry-features': FOUNDRY_FEATURES
      },
      body: JSON.stringify(bootPayload),
      signal: handle.abort.signal
    });
    if (!response.ok) {
      throw new Error(`foundry liveness invocation failed with HTTP ${response.status}`);
    }
    if (!response.body) {
      return;
    }
    // Drain the SSE stream so the request stays in-flight (which is what keeps the sandbox alive).
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done || handle.closed) {
          return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Stops the session's compute while keeping the session record and its `$HOME` sandbox, so the session becomes
   * cleanly inactive and a later invocation cold-boots a fresh container. Best-effort: a stop on a
   * not-exist/already-stopped session is a harmless no-op, so a failure is logged but never blocks scale-out/in.
   */
  private async stopSession(sessionId: string): Promise<void> {
    const url = `${this.base()}/endpoint/sessions/${encodeURIComponent(sessionId)}/stop?api-version=${API_VERSION}`;
    try {
      await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.token()}`,
          'foundry-features': FOUNDRY_FEATURES
        }
      });
    } catch (error) {
      console.error(`foundry session ${sessionId} stop failed`, error);
    }
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const url = `${this.base()}/endpoint/sessions/${encodeURIComponent(sessionId)}?api-version=${API_VERSION}`;
    try {
      await this.fetchImpl(url, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${await this.token()}`,
          'foundry-features': FOUNDRY_FEATURES
        }
      });
    } catch (error) {
      console.error(`foundry session ${sessionId} delete failed`, error);
    }
  }

  private buildBootPayload(input: HostPoolScaleOutInput): Record<string, unknown> {
    return {
      op: 'boot',
      centralUrl: input.pool.centralUrlForWorkers,
      tenantId: input.pool.tenantId,
      workerTypeId: this.workerType,
      labels: input.pool.template.labels,
      capacity: input.pool.template.capacity,
      workerPoolId: input.pool.poolId,
      workerPoolInstanceId: input.instance.instanceId
    };
  }

  private sessionIdFor(instance: { instanceId: string; workspaceRef?: string }): string {
    // The Foundry session id is the durable sandbox handle. For a session-pinned instance it is our session's stable
    // workspaceRef, so pausing (release) then resuming (a fresh instance carrying the same workspaceRef) reach the
    // same sandbox. Unpinned/shared instances fall back to a per-instance id.
    return instance.workspaceRef ?? `w-${instance.instanceId}`;
  }

  private base(): string {
    return `${this.projectEndpoint}/agents/${this.agentName}`;
  }

  private async token(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresOnTimestamp - Date.now() > TOKEN_REFRESH_SKEW_MS) {
      return this.cachedToken.token;
    }
    const token = await this.credential.getToken(TOKEN_SCOPE);
    if (!token) {
      throw new Error('Azure identity did not return a token for the Foundry data plane');
    }
    this.cachedToken = token;
    return token.token;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
