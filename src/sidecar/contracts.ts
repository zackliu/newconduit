import type { AgentOutputPayload, ResolvedAgentSpec, RuntimeChannel, RuntimeEvent, RuntimeEventHandler, RuntimeSubscription, SnapshotPart } from '../shared';

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

export interface SidecarWorkspaceCaptureInput {
  mount: SidecarWorkspaceMount;
  location: string;
}

export interface SidecarWorkspaceRestoreInput {
  mount: SidecarWorkspaceMount;
  location: string;
  parts: SnapshotPart[];
}

export interface SidecarWorkspaceAdapter {
  mount(input: SidecarWorkspaceMount): SidecarWorkspaceMount;
  capture(input: SidecarWorkspaceCaptureInput): Promise<SnapshotPart[]>;
  restore(input: SidecarWorkspaceRestoreInput): Promise<void>;
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

export interface SidecarAgentTurnResult {
  message?: string;
  output?: unknown;
}

export interface SidecarAgentProcessAdapter {
  start(input: SidecarAgentProcessStartInput): Promise<void>;
  send(input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<SidecarAgentTurnResult>;
  pauseAtTurnBoundary?(input: { sessionId: string }): Promise<void>;
  stop?(input: { sessionId: string }): Promise<void>;
}
