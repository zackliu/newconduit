import { mkdirSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SnapshotPartName } from '../../shared';
import type { SidecarWorkspaceAdapter, SidecarWorkspaceCaptureInput, SidecarWorkspaceHandles, SidecarWorkspaceMount, SidecarWorkspaceRestoreInput } from '../contracts';

const PART_DIRS: Record<SnapshotPartName, string> = {
  workspace: 'parts/workspace',
  'agent-state': 'parts/agent-state'
};

export interface DockerWorkspaceAdapterOptions {
  workRoot?: string;
  snapshotRoot?: string;
}

export class DockerWorkspaceAdapter implements SidecarWorkspaceAdapter {
  static readonly classId = 'volume-snapshot';
  private readonly workRoot: string;
  private readonly snapshotRootPath: string;

  constructor(options: DockerWorkspaceAdapterOptions = {}) {
    this.workRoot = resolve(options.workRoot ?? (process.env.SIDECAR_WORK_ROOT?.trim() || '.runtime-poc/sidecar'));
    this.snapshotRootPath = resolve(options.snapshotRoot ?? (process.env.SIDECAR_SNAPSHOT_ROOT?.trim() || '.runtime-poc/snapshots'));
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

  async capture(input: SidecarWorkspaceCaptureInput): Promise<SnapshotPartName[]> {
    const base = join(this.snapshotRootPath, input.handle);
    await this.copyDirectory(input.mount.workspacePath, join(base, PART_DIRS.workspace));
    await this.copyDirectory(input.mount.copilotSessionStatePath, join(base, PART_DIRS['agent-state']));
    return ['workspace', 'agent-state'];
  }

  async restore(input: SidecarWorkspaceRestoreInput): Promise<void> {
    const base = join(this.snapshotRootPath, input.handle);
    for (const part of input.parts) {
      const target = part === 'workspace' ? input.mount.workspacePath : input.mount.copilotSessionStatePath;
      await this.copyDirectory(join(base, PART_DIRS[part]), target);
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