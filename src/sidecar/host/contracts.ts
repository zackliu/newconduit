/**
 * Bootstrap facts a sidecar needs to register a Worker, independent of where they came from. The
 * `SidecarHostAdapter` decides the source (process env for self-hosted Docker/local, or a boot invocation
 * payload for a Foundry-hosted container), so the daemon composition stays identical across hosts.
 */
export interface SidecarBootstrap {
  centralUrl: string;
  tenantId: string;
  workerTypeId: string;
  hostPoolInstanceId?: string;
  labels: Record<string, string>;
  capacity: number;
  description?: Record<string, string>;
  /**
   * Optional host-managed storage root. A host adapter that knows its host's durable location (for example
   * Foundry, which only persists `$HOME` across idle scale-to-zero / recycle) sets this so host-managed storage
   * is rooted there; when absent the workspace adapter falls back to its deployment default (`SIDECAR_WORK_ROOT`).
   */
  workRoot?: string;
}

/** Builds and starts the worker daemon from resolved bootstrap facts. Owned by the sidecar entrypoint. */
export type StartSidecarWorker = (bootstrap: SidecarBootstrap) => Promise<void>;

/**
 * A sidecar host adapter owns how a sidecar process is bootstrapped and (for request-driven hosts) kept
 * alive: it resolves `SidecarBootstrap` and invokes `startWorker`. The command channel (Web PubSub) and the
 * daemon are unchanged across host adapters; only bootstrap source and any host-required liveness/health
 * surface differ. Implementations self-declare a `classId`; the entrypoint resolves one via the registry.
 */
export interface SidecarHostAdapter {
  run(startWorker: StartSidecarWorker): Promise<void>;
}
