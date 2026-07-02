import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SnapshotPartName } from '../../shared';
import type { SidecarWorkspaceAdapter, SidecarWorkspaceCaptureInput, SidecarWorkspaceHandles, SidecarWorkspaceMount, SidecarWorkspaceRestoreInput } from '../contracts';

export interface LocalWorkspaceAdapterOptions {
  workRoot?: string;
}

/**
 * Workspace class for self-managed local workers: workspace and Copilot session files live on the long-lived
 * worker and are owned by Copilot. Capture/restore are intentionally no-ops; persistence is not central's concern.
 */
export class LocalWorkspaceAdapter implements SidecarWorkspaceAdapter {
  static readonly classId = 'host-managed';
  private readonly workRoot: string;

  constructor(options: LocalWorkspaceAdapterOptions = {}) {
    this.workRoot = resolve(options.workRoot ?? (process.env.SIDECAR_WORK_ROOT?.trim() || '.runtime-poc/sidecar-local'));
  }

  mount(input: SidecarWorkspaceHandles): SidecarWorkspaceMount {
    if (!input.workspaceRef || !input.agentStateRef) {
      throw new Error('workspaceRef and agentStateRef are required');
    }
    const workspacePath = resolve(this.workRoot, 'workspaces', this.toSafePathSegment(input.workspaceRef));
    const copilotSessionStatePath = resolve(this.workRoot, 'copilot-sessions', this.toSafePathSegment(input.agentStateRef));
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(copilotSessionStatePath, { recursive: true });
    return { workspacePath, copilotSessionStatePath };
  }

  async capture(_input: SidecarWorkspaceCaptureInput): Promise<SnapshotPartName[]> {
    return [];
  }

  async restore(_input: SidecarWorkspaceRestoreInput): Promise<void> {
    return;
  }

  private toSafePathSegment(value: string): string {
    return encodeURIComponent(value).replaceAll('%', '_');
  }
}
