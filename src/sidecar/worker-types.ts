import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type SidecarClass } from '../shared';
import { CopilotProcessAdapter, DockerWorkspaceAdapter, LocalWorkspaceAdapter, WebPubSubClientAdapter } from './adapters';
import type { SidecarAgentProcessAdapter, SidecarRuntimeTransport, SidecarWorkspaceAdapter } from './contracts';

/**
 * A worker type names which sidecarClass, labels, capacity, and adapter classes a worker runs with. A worker
 * startup only references a worker type; it does not self-report sidecarClass/labels/capacity or wire adapters.
 * The worker-type data is user-configurable and read from the config directory; the adapter classes named by
 * the data are resolved from the compiled sidecar factory registries below.
 */
export interface WorkerType {
  workerTypeId: string;
  sidecarClass: SidecarClass;
  labels: Record<string, string>;
  capacity: number;
  createRuntimeTransport(input: { tenantId: string }): SidecarRuntimeTransport;
  createWorkspaceAdapter(): SidecarWorkspaceAdapter;
  createAgentProcessAdapter(): SidecarAgentProcessAdapter;
}

interface WorkerTypeConfig {
  workerTypeId: string;
  sidecarClass: SidecarClass;
  labels: Record<string, string>;
  capacity: number;
  runtimeTransportClass: string;
  workspaceClass: string;
  agentProcessClass: string;
}

type RuntimeTransportAdapterClass = (new (options: { tenantId: string }) => SidecarRuntimeTransport) & { classId: string };
type WorkspaceAdapterClass = (new () => SidecarWorkspaceAdapter) & { classId: string };
type AgentProcessAdapterClass = (new () => SidecarAgentProcessAdapter) & { classId: string };

// Each adapter self-declares its classId; the registries are generic maps keyed by that id, and config
// references the id. The lookup logic holds no config-value string literals.
const runtimeTransportsByClassId = indexByClassId<RuntimeTransportAdapterClass>([WebPubSubClientAdapter]);
const workspacesByClassId = indexByClassId<WorkspaceAdapterClass>([DockerWorkspaceAdapter, LocalWorkspaceAdapter]);
const agentProcessesByClassId = indexByClassId<AgentProcessAdapterClass>([CopilotProcessAdapter]);

export function resolveWorkerType(workerTypeId: string): WorkerType {
  const config = readWorkerTypeConfig(workerTypeId);
  const RuntimeTransport = requireClass(runtimeTransportsByClassId, config.runtimeTransportClass, 'runtimeTransportClass');
  const Workspace = requireClass(workspacesByClassId, config.workspaceClass, 'workspaceClass');
  const AgentProcess = requireClass(agentProcessesByClassId, config.agentProcessClass, 'agentProcessClass');
  return {
    workerTypeId: config.workerTypeId,
    sidecarClass: config.sidecarClass,
    labels: config.labels,
    capacity: config.capacity,
    createRuntimeTransport: ({ tenantId }) => new RuntimeTransport({ tenantId }),
    createWorkspaceAdapter: () => new Workspace(),
    createAgentProcessAdapter: () => new AgentProcess()
  };
}

function readWorkerTypeConfig(workerTypeId: string): WorkerTypeConfig {
  const directory = resolve(process.env.CONFIG_DIR ?? 'config', 'worker-types');
  let text: string;
  try {
    text = readFileSync(join(directory, `${workerTypeId}.json`), 'utf8');
  } catch {
    throw new Error(`unknown WORKER_TYPE: ${workerTypeId}`);
  }
  return JSON.parse(text) as WorkerTypeConfig;
}

function indexByClassId<T extends { classId: string }>(adapterClasses: T[]): Map<string, T> {
  return new Map(adapterClasses.map((adapterClass) => [adapterClass.classId, adapterClass]));
}

function requireClass<T>(byClassId: Map<string, T>, classId: string, field: string): T {
  const adapterClass = byClassId.get(classId);
  if (!adapterClass) {
    throw new Error(`unknown ${field}: ${classId}`);
  }
  return adapterClass;
}
