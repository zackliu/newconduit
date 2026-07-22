// Dev-only stand-in for the cloud "brain" of the Remote Network Recovery demo.
//
// This is NOT a reasoning agent. It registers a REAL `SidecarDaemon` Worker over Web PubSub whose
// labels match the `network-recovery-expert` AgentSpec, and on every turn it fires the Central-defined
// `scan_device_evidence` delegate tool with a bounded scan task. That exercises the exact production
// delegation path (parent turn -> delegate tool -> `device-scan-probe` child on the phone -> structured
// observation returned as the tool result) without needing a Copilot provider. Use a real Copilot worker for
// the production shape; use this only for a no-Copilot two-tab/two-device demo.
//
//   $env:CENTRAL_URL='http://localhost:3000'; $env:TENANT_ID='poc'; node samples/edge-worker/dev/scripted-parent.mjs
//
// Requires `pnpm build` (so dist/ exists) and the same Web PubSub env the Central uses.

import { pathToFileURL } from 'node:url';

const DEFAULT_CENTRAL_URL = 'http://localhost:3000';
const DEFAULT_TENANT_ID = 'poc';

/** Map a free-text operator instruction to a bounded capture task for the browser edge worker. */
function buildCaptureTask(message) {
  const text = (message ?? '').toLowerCase();
  if (/label|serial|model|barcode|qr/.test(text)) {
    return {
      task: 'capture',
      source: 'environment',
      target: 'model and serial label',
      reason: 'Read the exact hardware model/serial and any QR or barcode.',
      detect: ['code']
    };
  }
  if (/cabl|port|wan|dsl|connector|socket/.test(text)) {
    return {
      task: 'capture',
      source: 'environment',
      target: 'WAN/DSL port and cabling',
      reason: 'Inspect the physical connection area and report framing/lighting.',
      detect: []
    };
  }
  return {
    task: 'capture',
    source: 'environment',
    target: 'front-panel status LEDs',
    reason: 'Read the indicator lights and report their colours and which are lit.',
    detect: ['led-indicator']
  };
}

/** Scripted agent: emits one delegate tool_call per turn and returns the structured result verbatim. */
class ScriptedCaptureAgentAdapter {
  #pending = new Map();

  async start() {}

  async send(input, emit) {
    // The operator's device-routing intent arrives as the turn's structured `delegationTarget` (trusted control
    // metadata Central already bound to this turn), NOT as text in the message. A real Copilot agent would set the
    // tool `target` from the case roster; this scripted brain echoes the enforced target so the demo drives per-device
    // and fan-out routing without a live model. Central enforces its durable copy regardless of what is echoed here.
    const task = buildCaptureTask(input.message);
    const interactionId = `capture-${input.sessionId}-${input.turnSeq}`;
    const settled = new Promise((resolve) => this.#pending.set(interactionId, resolve));
    await emit({
      type: 'interaction',
      payload: {
        interactionId,
        kind: 'tool_call',
        request: { toolName: 'scan_device_evidence', arguments: { message: JSON.stringify(task), target: input.delegationTarget } }
      }
    });
    const response = await settled;
    return {
      message: `On-device capture of "${task.target}" complete. Structured observation received; planning next step.`,
      output: { toolResult: response }
    };
  }

  async respondToInteraction(input) {
    const resolve = this.#pending.get(input.interactionId);
    if (resolve) {
      this.#pending.delete(input.interactionId);
      resolve(input.response);
    }
  }
}

/** Host-managed passthrough workspace: this scripted brain keeps no real workspace. */
class PassthroughWorkspaceAdapter {
  mount(input) {
    return { workspacePath: input.workspaceRef, copilotSessionStatePath: input.agentStateRef };
  }
  async capture() {
    return ['workspace', 'agent-state'];
  }
  async restore() {}
}

/**
 * Build the standalone-worker registration this dev brain sends to central. Exported and pure so a test can
 * assert its shape without booting the daemon: `description` must be a `Record<string,string>` (central's
 * `isWorkerRegisterPayload` rejects a bare string with HTTP 400), and the labels must match the
 * `network-recovery-expert` AgentSpec's worker selector.
 */
export function buildWorkerRegistration({ centralUrl = DEFAULT_CENTRAL_URL, tenantId = DEFAULT_TENANT_ID } = {}) {
  return {
    centralUrl,
    tenantId,
    storageClass: 'host-managed',
    labels: { agent: 'copilot', tier: 'foundry', role: 'network-recovery-expert', storage: 'host-managed' },
    description: { kind: 'scripted-parent', role: 'network-recovery-expert' },
    capacity: 1,
    allocatable: 1
  };
}

async function main() {
  const centralUrl = process.env.CENTRAL_URL ?? DEFAULT_CENTRAL_URL;
  const tenantId = process.env.TENANT_ID ?? DEFAULT_TENANT_ID;

  // Loaded lazily so importing this module for its pure builders never requires a prior `pnpm build`.
  const { SidecarDaemon, WebPubSubClientAdapter } = await import('../../../dist/sidecar/index.js');

  const daemon = new SidecarDaemon({
    runtimeTransport: new WebPubSubClientAdapter({ tenantId }),
    workspaceAdapter: new PassthroughWorkspaceAdapter(),
    agentProcessAdapter: new ScriptedCaptureAgentAdapter()
  });

  const worker = await daemon.startStandaloneWorker(buildWorkerRegistration({ centralUrl, tenantId }));

  console.log(`[scripted-parent] registered as worker ${worker.workerId} on tenant ${tenantId} (central ${centralUrl})`);
  console.log('[scripted-parent] dev stand-in only — fires scan_device_evidence per turn; it does not reason.');
  console.log('[scripted-parent] Ctrl+C to stop.');

  const shutdown = async () => {
    try {
      await daemon.stop?.();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void main().catch((error) => {
    console.error('[scripted-parent] failed:', error);
    process.exitCode = 1;
  });
}
