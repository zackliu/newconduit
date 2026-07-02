import { CopilotProcessAdapter, DockerWorkspaceAdapter, LocalWorkspaceAdapter } from './adapters';
import type { SidecarAgentProcessAdapter, SidecarWorkspaceAdapter } from './contracts';

/**
 * A worker type is an image-declared build profile: it names the storage data-half (workspace) adapter and the
 * agent-process adapter the image ships with. Labels and capacity are NOT part of the build profile - they are
 * declared once on the WorkerPool template (or passed explicitly for standalone workers). Runtime transport is a
 * deployment-level choice, not per-type.
 *
 * The profile's workspace adapter self-declares a classId; that same id is the worker's `storageClass`, which
 * central records at assignment and uses to resolve the matching storage control-half.
 */
export interface WorkerBuildProfile {
  workerTypeId: string;
  storageClass: string;
  createWorkspaceAdapter(): SidecarWorkspaceAdapter;
  createAgentProcessAdapter(): SidecarAgentProcessAdapter;
}

type WorkspaceAdapterClass = (new () => SidecarWorkspaceAdapter) & { classId: string };
type AgentProcessAdapterClass = new () => SidecarAgentProcessAdapter;

function buildProfile(workerTypeId: string, Workspace: WorkspaceAdapterClass, AgentProcess: AgentProcessAdapterClass): WorkerBuildProfile {
  return {
    workerTypeId,
    storageClass: Workspace.classId,
    createWorkspaceAdapter: () => new Workspace(),
    createAgentProcessAdapter: () => new AgentProcess()
  };
}

// Each worker type is a fixed adapter combination baked into an image; there is no per-type config document.
// The adapters self-declare their classId and the combination is code.
const BUILD_PROFILES: Record<string, WorkerBuildProfile> = {
  'copilot-process-wrapper': buildProfile('copilot-process-wrapper', DockerWorkspaceAdapter, CopilotProcessAdapter),
  'copilot-local': buildProfile('copilot-local', LocalWorkspaceAdapter, CopilotProcessAdapter),
  'dotnet-process-wrapper': buildProfile('dotnet-process-wrapper', DockerWorkspaceAdapter, CopilotProcessAdapter)
};

export function resolveWorkerType(workerTypeId: string): WorkerBuildProfile {
  const resolved = BUILD_PROFILES[workerTypeId];
  if (!resolved) {
    throw new Error(`unknown WORKER_TYPE: ${workerTypeId}`);
  }
  return resolved;
}
