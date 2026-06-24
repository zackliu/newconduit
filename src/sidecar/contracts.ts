import type { RuntimeChannel, RuntimeEvent, WorkerRegisterPayload } from '../shared';

export interface SidecarRuntimeTransport {
  connect(accessUrl: string): Promise<void>;
  publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void>;
  stop(): Promise<void>;
}

export interface SidecarWorkspaceMount {
  workspaceVolume: string;
  copilotSessionVolume: string;
}

export interface SidecarWorkspaceAdapter {
  mount(input: SidecarWorkspaceMount): SidecarWorkspaceMount;
}

export interface SidecarAgentProcessAdapter {
  start(input: SidecarWorkspaceMount): Promise<void>;
}

export interface WorkerRegistrationEventFactory {
  createRegisterEvent(payload: WorkerRegisterPayload): RuntimeEvent<WorkerRegisterPayload>;
}