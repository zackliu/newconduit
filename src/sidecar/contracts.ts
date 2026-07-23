import type { AgentOutputPayload, DelegationTarget, InteractionKind, ResolvedAgentSpec, RuntimeChannel, RuntimeEvent, RuntimeEventHandler, RuntimeSubscription, SnapshotPartName } from '../shared';

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
  /** Operator-authoritative delegation target Central bound to this turn, forwarded so a delegating agent adapter
   * may set the delegate tool's `target` to match it. Central still enforces it independently. Absent for ordinary
   * turns and non-delegating agents. */
  delegationTarget?: DelegationTarget;
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
  /** Non-secret runtime/provider identity facts the daemon merges into the Worker registration description so
   *  Central and operators can positively identify the concrete runtime behind a Worker (e.g. a real Copilot
   *  process and its model/provider host) rather than inferring it from selector labels alone. Must never include
   *  bearer tokens, keys, or any other secret. Optional: adapters that carry no useful identity omit it. */
  describeRuntime?(): Record<string, string>;
  respondToInteraction?(input: SidecarInteractionResponseInput): Promise<void>;
  pauseAtTurnBoundary?(input: { sessionId: string }): Promise<void>;
  stop?(input: { sessionId: string }): Promise<void>;
}
