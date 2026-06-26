import { mkdirSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SnapshotPart } from '../../shared';
import type { SidecarWorkspaceAdapter, SidecarWorkspaceCaptureInput, SidecarWorkspaceMount, SidecarWorkspaceRestoreInput } from '../contracts';

const WORKSPACE_PART: SnapshotPart = { name: 'workspace', path: 'parts/workspace' };
const AGENT_STATE_PART: SnapshotPart = { name: 'agent-state', path: 'parts/agent-state' };

export interface DockerWorkspaceAdapterOptions {
  workRoot?: string;
  snapshotRoot?: string;
}

export class DockerWorkspaceAdapter implements SidecarWorkspaceAdapter {
  private readonly workRoot: string;
  private readonly snapshotRootPath: string;

  constructor(options: DockerWorkspaceAdapterOptions = {}) {
    this.workRoot = resolve(options.workRoot ?? (process.env.SIDECAR_WORK_ROOT?.trim() || '.runtime-poc/sidecar'));
    this.snapshotRootPath = resolve(options.snapshotRoot ?? (process.env.SIDECAR_SNAPSHOT_ROOT?.trim() || '.runtime-poc/snapshots'));
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

  async capture(input: SidecarWorkspaceCaptureInput): Promise<SnapshotPart[]> {
    const base = join(this.snapshotRootPath, input.location);
    await this.copyDirectory(input.mount.workspacePath, join(base, WORKSPACE_PART.path));
    await this.copyDirectory(input.mount.copilotSessionStatePath, join(base, AGENT_STATE_PART.path));
    return [WORKSPACE_PART, AGENT_STATE_PART];
  }

  async restore(input: SidecarWorkspaceRestoreInput): Promise<void> {
    const base = join(this.snapshotRootPath, input.location);
    for (const part of input.parts) {
      const target = part.name === 'workspace' ? input.mount.workspacePath : input.mount.copilotSessionStatePath;
      await this.copyDirectory(join(base, part.path), target);
    }
  }

  private async copyDirectory(source: string, target: string): Promise<void> {
    await mkdir(target, { recursive: true });
    await cp(source, target, { recursive: true, force: true });
  }

  private toSafePathSegment(value: string): string {
    return encodeURIComponent(value).replaceAll('%', '_');
  }
}