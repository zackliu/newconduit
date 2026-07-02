import type { AgentOutputPayload, InteractionKind, ResolvedAgentSpec, RuntimeChannel, RuntimeEvent, RuntimeEventHandler, RuntimeSubscription, SnapshotPart } from '../shared';

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

export interface SidecarInteractionRequest {
  interactionId: string;
  kind: InteractionKind;
  request: unknown;
}

export type SidecarAgentProcessEvent =
  | { type: 'output'; payload: AgentOutputPayload }
  | { type: 'interaction'; payload: SidecarInteractionRequest };

export type SidecarAgentProcessEventHandler = (event: SidecarAgentProcessEvent) => Promise<void> | void;

export interface SidecarInteractionResponseInput {
  sessionId: string;
  interactionId: string;
  kind: InteractionKind;
  response: unknown;
}

export interface SidecarAgentTurnResult {
  message?: string;
  output?: unknown;
}

export interface SidecarAgentProcessAdapter {
  start(input: SidecarAgentProcessStartInput): Promise<void>;
  send(input: SidecarAgentProcessInput, emit: SidecarAgentProcessEventHandler): Promise<SidecarAgentTurnResult>;
  respondToInteraction?(input: SidecarInteractionResponseInput): Promise<void>;
  pauseAtTurnBoundary?(input: { sessionId: string }): Promise<void>;
  stop?(input: { sessionId: string }): Promise<void>;
}
