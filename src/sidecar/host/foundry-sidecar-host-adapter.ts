import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { SidecarBootstrap, SidecarHostAdapter, StartSidecarWorker } from './contracts';

const DEFAULT_PORT = 8088;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HOST_MANAGED_WORK_SUBDIR = 'agent-runtime';

/**
 * Resolves the host-managed work root for a Foundry-hosted worker. Foundry only persists `$HOME` across idle
 * scale-to-zero and container recycle; any other writable location (for example the image's `/runtime`) is
 * ephemeral and wiped when a paused session resumes onto a fresh container. Host-managed storage (the Copilot
 * workspace + session state, whose capture/restore are no-ops) must therefore live under `$HOME` to survive
 * pause/resume. Keep an operator-provided root only if it already sits inside `$HOME`; otherwise root it under
 * `$HOME`. `home` comes from `os.homedir()` at runtime, so this is correct for whatever `$HOME` the platform sets.
 */
export function hostManagedWorkRootUnderHome(current: string | undefined, home: string): string {
  const trimmed = current?.trim();
  if (trimmed && isInside(trimmed, home)) {
    return trimmed;
  }
  return posix.join(home, HOST_MANAGED_WORK_SUBDIR);
}

/** True when `candidate` is `home` itself or a path nested inside it (not merely a sibling that shares a prefix). */
function isInside(candidate: string, home: string): boolean {
  const rel = posix.relative(posix.resolve(home), posix.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !posix.isAbsolute(rel));
}

/**
 * Host adapter for a Foundry-hosted container. Foundry owns the container lifecycle (request-driven,
 * idle scale-to-zero), so the sidecar must (a) answer the hosted-agent HTTP contract and (b) let central keep
 * it alive by holding one long `/invocations` request open. This adapter serves `/readiness` and a
 * boot/keepalive `/invocations` handler: the first invocation carries the boot payload and starts the worker
 * exactly once; every invocation is then held open, streaming heartbeats, as the liveness channel. The command
 * channel is still Web PubSub inside the started daemon — this HTTP surface never carries session commands.
 */
export class FoundrySidecarHostAdapter implements SidecarHostAdapter {
  static readonly classId = 'foundry';

  private startWorker: StartSidecarWorker | undefined;
  private booting = false;
  private workerStart: Promise<void> | undefined;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async run(startWorker: StartSidecarWorker): Promise<void> {
    this.startWorker = startWorker;
    const port = Number(this.env.PORT ?? DEFAULT_PORT);
    await new Promise<void>((_resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch((error: unknown) => {
          console.error('sidecar foundry host request failed', error);
          if (!res.headersSent) {
            res.writeHead(500);
          }
          if (!res.writableEnded) {
            res.end();
          }
        });
      });
      server.on('error', reject);
      server.listen(port, () => {
        console.log(`sidecar foundry host adapter listening on :${port} (/readiness + /invocations liveness)`);
      });
      // Never resolve: the process stays up serving the container contract until the platform stops it.
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/readiness') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method === 'POST' && path === '/invocations') {
      await this.handleInvocation(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  }

  private async handleInvocation(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = await this.readJsonBody(req);
    if (!this.booting) {
      if (!this.startWorker) {
        throw new Error('foundry host adapter received an invocation before run() wired startWorker');
      }
      this.booting = true;
      this.workerStart = this.startWorker(this.toBootstrap(payload));
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    });
    const startedAt = Date.now();
    this.writeEvent(res, { event: 'liveness_start', now: new Date().toISOString() });

    void this.workerStart
      ?.then(() => this.writeEvent(res, { event: 'worker_ready', now: new Date().toISOString() }))
      .catch((error: unknown) => {
        this.writeEvent(res, { event: 'worker_failed', error: error instanceof Error ? error.message : String(error) });
        if (!res.writableEnded) {
          res.end();
        }
      });

    const timer = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(timer);
        return;
      }
      this.writeEvent(res, { event: 'heartbeat', elapsed_s: Math.round((Date.now() - startedAt) / 1000), now: new Date().toISOString() });
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();

    const cleanup = (): void => clearInterval(timer);
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  private writeEvent(res: ServerResponse, data: Record<string, unknown>): void {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    if (!body) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(body);
      return this.isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private toBootstrap(payload: Record<string, unknown>): SidecarBootstrap {
    const centralUrl = this.requireString(payload, 'centralUrl');
    const workerTypeId = this.requireString(payload, 'workerTypeId');
    const capacity = Number(payload.capacity);
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error('boot payload capacity must be a positive integer');
    }
    return {
      centralUrl,
      tenantId: typeof payload.tenantId === 'string' ? payload.tenantId : 'poc',
      workerTypeId,
      labels: this.toStringRecord(payload.labels),
      capacity,
      description: this.toDescription(payload),
      // Foundry only persists `$HOME` across idle scale-to-zero / recycle; root host-managed storage there so the
      // workspace + Copilot session state survive pause/resume (see hostManagedWorkRootUnderHome).
      workRoot: hostManagedWorkRootUnderHome(this.env.SIDECAR_WORK_ROOT, homedir())
    };
  }

  private toDescription(payload: Record<string, unknown>): Record<string, string> | undefined {
    const workerPoolId = typeof payload.workerPoolId === 'string' ? payload.workerPoolId : undefined;
    const workerPoolInstanceId = typeof payload.workerPoolInstanceId === 'string' ? payload.workerPoolInstanceId : undefined;
    if (!workerPoolId && !workerPoolInstanceId) {
      return undefined;
    }
    return {
      ...(workerPoolId ? { workerPoolId } : {}),
      ...(workerPoolInstanceId ? { workerPoolInstanceId } : {})
    };
  }

  private toStringRecord(value: unknown): Record<string, string> {
    if (!this.isRecord(value)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') {
        result[key] = entry;
      }
    }
    return result;
  }

  private requireString(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`boot payload ${key} is required`);
    }
    return value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
