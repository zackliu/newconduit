import type { AgentOutputPayload, ResolvedAgentSpec, RuntimeChannel, RuntimeEvent, RuntimeEventHandler, RuntimeSubscription } from '../shared';

export interface SidecarRuntimeTransport {
  connect(accessUrl: string): Promise<void>;
  publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void>;
  subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription>;
  stop(): Promise<void>;
}

export interface SidecarWorkspaceMount {
  workspacePath: string;
  copilotSessionStatePath: string;
}

export interface SidecarWorkspaceAdapter {
  mount(input: SidecarWorkspaceMount): SidecarWorkspaceMount;
}

export interface SidecarAgentProcessStartInput extends SidecarWorkspaceMount {
  sessionId: string;
  workerId: string;
  sessionLeaseId: string;
  resolvedAgentSpec: ResolvedAgentSpec;
}

export interface SidecarAgentProcessInput {
  sessionId: string;
  turnSeq: number;
  message: string;
}

export interface SidecarAgentProcessEvent {
  type: 'output';
  payload: AgentOutputPayload;
}

export type SidecarAgentProcessEventHandler = (event: SidecarAgentProcessEvent) => Promise<void> | void;

export interface SidecarAgentProcessAdapter {
  start(input: SidecarAgentProcessStartInput): Promise<void>;
  send(input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<void>;
  stop?(input: { sessionId: string }): Promise<void>;
}
