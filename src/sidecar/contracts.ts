import type { AgentOutputPayload, InteractionKind, ResolvedAgentSpec, RuntimeChannel, RuntimeEvent, RuntimeEventHandler, RuntimeSubscription, SnapshotPartName } from '../shared';

export interface SidecarRuntimeTransport {
  connect(accessUrl: string): Promise<void>;
  publish(channel: RuntimeChannel, event: RuntimeEvent): Promise<void>;
  subscribe(channel: RuntimeChannel, handler: RuntimeEventHandler): Promise<RuntimeSubscription>;
  stop(): Promise<void>;
}

/** Opaque storage handles central routes to the worker; the workspace data-half resolves them to real paths. */
export interface SidecarWorkspaceHandles {
  workspaceRef: string;
  agentStateRef: string;
}

export interface SidecarWorkspaceMount {
  workspacePath: string;
  copilotSessionStatePath: string;
}

export interface SidecarWorkspaceCaptureInput {
  mount: SidecarWorkspaceMount;
  handle: string;
}

export interface SidecarWorkspaceRestoreInput {
  mount: SidecarWorkspaceMount;
  handle: string;
  parts: SnapshotPartName[];
}

export interface SidecarWorkspaceAdapter {
  mount(input: SidecarWorkspaceHandles): SidecarWorkspaceMount;
  capture(input: SidecarWorkspaceCaptureInput): Promise<SnapshotPartName[]>;
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
