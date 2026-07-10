import { EnvSidecarHostAdapter } from './env-sidecar-host-adapter';
import { FoundrySidecarHostAdapter } from './foundry-sidecar-host-adapter';
import type { SidecarHostAdapter } from './contracts';

export type { SidecarBootstrap, SidecarHostAdapter, StartSidecarWorker } from './contracts';
export { EnvSidecarHostAdapter } from './env-sidecar-host-adapter';
export { FoundrySidecarHostAdapter } from './foundry-sidecar-host-adapter';

// Generic registry of sidecar host adapters keyed by each adapter's self-declared classId. Deployment names a
// host class via SIDECAR_HOST_CLASS; this map resolves it without enumerating any specific class literal.
const SIDECAR_HOST_ADAPTER_FACTORIES: Record<string, () => SidecarHostAdapter> = {
  [EnvSidecarHostAdapter.classId]: () => new EnvSidecarHostAdapter(),
  [FoundrySidecarHostAdapter.classId]: () => new FoundrySidecarHostAdapter()
};

export function resolveSidecarHostAdapter(classId: string): SidecarHostAdapter {
  const factory = SIDECAR_HOST_ADAPTER_FACTORIES[classId];
  if (!factory) {
    throw new Error(`unknown SIDECAR_HOST_CLASS: ${classId}`);
  }
  return factory();
}

/** Default host class when a deployment does not set SIDECAR_HOST_CLASS: self-hosted env bootstrap. */
export function defaultSidecarHostClassId(): string {
  return EnvSidecarHostAdapter.classId;
}
