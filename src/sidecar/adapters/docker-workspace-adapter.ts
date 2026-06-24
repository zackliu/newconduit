import type { SidecarWorkspaceAdapter, SidecarWorkspaceMount } from '../contracts';

export class DockerWorkspaceAdapter implements SidecarWorkspaceAdapter {
  mount(input: SidecarWorkspaceMount): SidecarWorkspaceMount {
    return input;
  }
}