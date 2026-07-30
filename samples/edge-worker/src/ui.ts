/** Tiny DOM helpers shared by both roles. Kept dependency-free to match the repo's minimal-deps policy. */

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function fmtPct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function severityClass(severity: string): string {
  switch (severity) {
    case 'issue':
      return 'sev-issue';
    case 'warn':
      return 'sev-warn';
    case 'info':
      return 'sev-info';
    default:
      return 'sev-ok';
  }
}

export function shortId(value: string | undefined): string {
  if (!value) return '—';
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-3)}`;
}

export function timestamp(): string {
  return new Date().toLocaleTimeString([], { hour12: false });
}

export type DeviceStageState = 'done' | 'active' | 'idle';

export interface DeviceStage {
  label: string;
  state: DeviceStageState;
}

/**
 * The console presents four distinct, non-conflated lifecycle stages for a paired edge device. Each stage is
 * derived only from real observed state (a pair-scoped worker view + the delegated child + received evidence),
 * so "paired/online" is shown as soon as the device registers — before any scan is delegated — and never
 * implies work is happening. Pure and DOM-free so the progression can be unit-tested.
 */
/**
 * Terminal states of a delegated child *session* (not a single turn). When a paired browser worker is lost
 * mid-scan, Central fails the child session (status `failed`) rather than silently re-routing to another tab,
 * so the console keys its "device lost" surfacing off this — never off a transient turn error, which leaves the
 * reusable child session alive. `cancelled` is included for an operator-cancelled scan.
 */
export function isTerminalChildStatus(status: string | undefined): boolean {
  return status === 'failed' || status === 'cancelled';
}

export type ScanRoute = 'idle' | 'awaiting-device' | 'in-flight' | 'device-lost';

/**
 * Pure derivation of how a delegated scan is routing, so the console can show an *explicit* outcome instead of a
 * turn that silently spins "working". `device-lost` (the child session terminated because its paired worker
 * dropped) takes precedence and drives the retry affordance; `awaiting-device` means a scan is delegated but the
 * pair-scoped worker is offline (it will not fall back to an unrelated device). DOM-free so it can be unit-tested.
 */
export function computeScanRoute(input: {
  scanActive: boolean;
  childTerminated: boolean;
  deviceOnline: boolean;
}): ScanRoute {
  if (input.childTerminated) return 'device-lost';
  if (input.scanActive && !input.deviceOnline) return 'awaiting-device';
  if (input.scanActive) return 'in-flight';
  return 'idle';
}

export function computeDeviceStages(input: {
  online: boolean;
  busy: boolean;
  assigned: boolean;
  childRunning: boolean;
  hasIncompleteRecord: boolean;
  hasEvidence: boolean;
}): DeviceStage[] {
  const online = input.online;
  const assigned = input.assigned;
  const capturing = input.busy || input.childRunning || input.hasIncompleteRecord;
  const evidence = input.hasEvidence;
  const at = (active: boolean, done: boolean): DeviceStageState => (done ? 'done' : active ? 'active' : 'idle');
  return [
    { label: 'Paired · online', state: at(online, assigned || capturing || evidence) },
    { label: 'Scan delegated', state: at(assigned && !capturing && !evidence, capturing || evidence) },
    { label: 'Capturing', state: at(capturing && !evidence, evidence) },
    { label: 'Evidence received', state: at(evidence, false) }
  ];
}

/**
 * The operator's device-routing intent for a scan: every rostered device (`{scope:'all'}`), one specific
 * Central-authoritative `deviceRef`, or an explicit subset (`{deviceRefs}`, used by a failed-only retry). The console
 * sends this to Central as the turn's structured `delegationTarget` (a typed SDK field), where Central binds it to
 * the accepted turn and enforces it on the matching delegate call. It is never encoded into the agent's message text.
 */
export type ScanTarget = { scope: 'all' } | { deviceRef: string } | { deviceRefs: string[] };

/**
 * Which join action a Device Scan tab may take, derived purely from whether it already holds a durable Central
 * binding and whether a fresh one-time invite is present:
 *  - `unpaired`   — no binding, no invite: the tab must open a pairing link before it can join.
 *  - `invite`     — no binding, invite present: redeem the invite once into a durable binding, then register.
 *  - `reconnect`  — binding present, no invite: re-register with the stored binding credential (no invite needed).
 *  - `conflict`   — binding present AND a fresh invite present (e.g. an invite minted from a DIFFERENT console/case).
 *
 * The `conflict` case is the important one: a tab must never silently discard the new invite and reconnect the old
 * case (the operator who opened the new link would see nothing), and it must never overwrite its binding client-side
 * and leave an orphaned, still-active Central binding on the old case. v1 resolves the conflict by keeping the
 * current case — the new invite is dropped only on an explicit user action — and treats moving a device to another
 * case as an operator close-case flow, not a silent swap. DOM-free so the decision can be unit-tested.
 */
export type JoinGate = 'unpaired' | 'invite' | 'reconnect' | 'conflict';

export function computeJoinGate(input: { hasBinding: boolean; hasInvite: boolean }): JoinGate {
  if (input.hasBinding && input.hasInvite) return 'conflict';
  if (input.hasBinding) return 'reconnect';
  if (input.hasInvite) return 'invite';
  return 'unpaired';
}

/**
 * Whether the operator console may hand the durable recovery agent a new instruction. Central only accepts a turn
 * once the parent case has a worker attached — its status is `running`; sending while the case is still `queued`,
 * `created`, `starting`, or `paused` fails immediately with `no_current_worker` (the turn is accepted then failed
 * because there is no worker to route it to). So the console gates instruction entry on the parent actually being
 * `running` and shows an explicit "waiting for parent capacity" state otherwise. This also honestly models a single
 * capacity-1 agent pool: a second recovery case stays `queued` (not runnable) until the first frees the worker.
 * DOM-free so the gate can be unit-tested.
 */
export type InstructionGate = 'disconnected' | 'no-session' | 'waiting-capacity' | 'sending' | 'ready';

export function computeInstructionGate(input: {
  connected: boolean;
  hasParent: boolean;
  parentStatus: string;
  sending: boolean;
}): InstructionGate {
  if (!input.connected) return 'disconnected';
  if (!input.hasParent) return 'no-session';
  if (input.sending) return 'sending';
  return input.parentStatus === 'running' ? 'ready' : 'waiting-capacity';
}
