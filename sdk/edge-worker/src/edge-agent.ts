/**
 * An edge agent is the local "agent process" the browser worker runs for each assigned session turn.
 * It is the browser peer of the Node sidecar's agent-process adapter: it receives a turn message, may
 * stream progress, and returns a structured result. The default implementation is the
 * `CameraDiagnosticAgent`, but the interface keeps the runtime independent of any specific device task.
 */

export interface EdgeTurnInput {
  sessionId: string;
  turnSeq: number;
  /** Raw turn message routed from the cloud session. Structured tasks are encoded as JSON here. */
  message: string;
}

export interface EdgeTurnResult {
  /** Short human-readable summary rendered in the console thread. */
  message?: string;
  /** Bounded structured evidence. MUST NOT contain raw captured media. */
  output?: unknown;
}

export interface EdgeAgentContext {
  /** Emit an incremental progress line to the console for this turn. */
  progress(text: string): Promise<void> | void;
  /** Emit an incremental assistant delta (appended to the streamed message). */
  delta(text: string): Promise<void> | void;
  /** Cooperative cancellation when the session is paused mid-turn. */
  readonly signal: AbortSignal;
}

export interface EdgeAgent {
  /** Optional one-time setup when a session is assigned to this worker. */
  start?(input: { sessionId: string; agentSpecId: string }): Promise<void> | void;
  /** Run a single turn and return its structured result. */
  runTurn(input: EdgeTurnInput, context: EdgeAgentContext): Promise<EdgeTurnResult>;
  /** Optional teardown when the session is paused or the worker stops. */
  stop?(input: { sessionId: string }): Promise<void> | void;
}
