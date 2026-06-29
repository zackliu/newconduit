import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SnapshotPart } from '../../shared';
import type { SidecarWorkspaceAdapter, SidecarWorkspaceCaptureInput, SidecarWorkspaceMount, SidecarWorkspaceRestoreInput } from '../contracts';

export interface LocalWorkspaceAdapterOptions {
  workRoot?: string;
}

/**
 * Workspace class for self-managed local workers: workspace and Copilot session files live on the long-lived
 * worker and are owned by Copilot. Capture/restore are intentionally no-ops; persistence is not central's concern.
 */
export class LocalWorkspaceAdapter implements SidecarWorkspaceAdapter {
  private readonly workRoot: string;

  constructor(options: LocalWorkspaceAdapterOptions = {}) {
    this.workRoot = resolve(options.workRoot ?? (process.env.SIDECAR_WORK_ROOT?.trim() || '.runtime-poc/sidecar-local'));
  }

  mount(input: SidecarWorkspaceMount): SidecarWorkspaceMount {
    if (!input.workspacePath || !input.copilotSessionStatePath) {
      throw new Error('workspacePath and copilotSessionStatePath are required');
    }
    const workspacePath = resolve(this.workRoot, 'workspaces', this.toSafePathSegment(input.workspacePath));
    const copilotSessionStatePath = resolve(this.workRoot, 'copilot-sessions', this.toSafePathSegment(input.copilotSessionStatePath));
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(copilotSessionStatePath, { recursive: true });
    return { workspacePath, copilotSessionStatePath };
  }

  async capture(_input: SidecarWorkspaceCaptureInput): Promise<SnapshotPart[]> {
    return [];
  }

  async restore(_input: SidecarWorkspaceRestoreInput): Promise<void> {
    return;
  }

  private toSafePathSegment(value: string): string {
    return encodeURIComponent(value).replaceAll('%', '_');
  }
}
