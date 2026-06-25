import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SidecarWorkspaceAdapter, SidecarWorkspaceMount } from '../contracts';

export class DockerWorkspaceAdapter implements SidecarWorkspaceAdapter {
  mount(input: SidecarWorkspaceMount): SidecarWorkspaceMount {
    if (!input.workspacePath || !input.copilotSessionStatePath) {
      throw new Error('workspacePath and copilotSessionStatePath are required');
    }
    const root = resolve(process.env.SIDECAR_WORK_ROOT?.trim() || '.runtime-poc/sidecar');
    const workspacePath = resolve(root, 'workspaces', this.toSafePathSegment(input.workspacePath));
    const copilotSessionStatePath = resolve(root, 'copilot-sessions', this.toSafePathSegment(input.copilotSessionStatePath));
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(copilotSessionStatePath, { recursive: true });
    return { workspacePath, copilotSessionStatePath };
  }

  private toSafePathSegment(value: string): string {
    return encodeURIComponent(value).replaceAll('%', '_');
  }
}