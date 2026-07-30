import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CameraDiagnosticAgent,
  type CaptureOutcome,
  type CaptureProvider,
  type EdgeDeviceManifest
} from '../src/analysis/camera-diagnostic-agent';
import { createAnalyzerCaptureProvider } from '../src/analysis/frame-capture-provider';
import { CanvasHeuristicAnalyzer, type EdgeFrame } from '../src/analysis/frame-analyzer';
import type { EdgeAgentContext } from '../src/edge-agent';

function noopContext(): EdgeAgentContext {
  return {
    progress: () => undefined,
    delta: () => undefined,
    signal: new AbortController().signal
  };
}

function manifest(overrides: Partial<EdgeDeviceManifest> = {}): EdgeDeviceManifest {
  return {
    deviceLabel: 'Test Device',
    runtime: 'browser-edge-worker',
    captureSources: ['environment', 'user'],
    analyzers: [{ id: 'canvas-heuristic-v1', displayName: 'Canvas heuristic analyzer' }],
    secureContext: true,
    privacy: { rawMediaLeavesDevice: false, returns: 'structured-analysis-only' },
    ...overrides
  };
}

function solidFrame(rgb: [number, number, number]): EdgeFrame {
  const width = 24;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

test('camera agent: a manifest task reports capabilities without touching the capture provider', async () => {
  let captureCalls = 0;
  const provider: CaptureProvider = {
    async capture() {
      captureCalls++;
      return { status: 'declined', reason: 'should not be called' };
    }
  };
  const agent = new CameraDiagnosticAgent({ captureProvider: provider, manifestProvider: () => manifest() });

  const result = await agent.runTurn({ sessionId: 's1', turnSeq: 2, message: JSON.stringify({ task: 'manifest' }) }, noopContext());

  assert.equal(captureCalls, 0);
  const output = result.output as { kind: string; manifest: EdgeDeviceManifest };
  assert.equal(output.kind, 'device-manifest');
  assert.deepEqual(output.manifest.captureSources, ['environment', 'user']);
  assert.equal(output.manifest.privacy.rawMediaLeavesDevice, false);
});

test('camera agent: a capture task returns structured evidence and never includes the raw frame', async () => {
  const provider = createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), async () => ({
    status: 'captured',
    captured: { frame: solidFrame([200, 130, 80]), source: 'environment', sampleSource: 'camera', facingMode: 'environment' }
  }));
  const agent = new CameraDiagnosticAgent({ captureProvider: provider, manifestProvider: () => manifest() });

  const result = await agent.runTurn(
    { sessionId: 's1', turnSeq: 3, message: JSON.stringify({ task: 'capture', target: 'display', source: 'environment' }) },
    noopContext()
  );

  const output = result.output as Record<string, unknown>;
  assert.equal(output.kind, 'device-evidence');
  assert.equal(output.status, 'captured');
  assert.equal(output.source, 'environment');
  assert.ok(output.analysis, 'structured analysis must be present');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('"data"'), 'raw RGBA buffer must never leave the device');
  assert.ok(!('frame' in output));
  const analysis = output.analysis as { signals: { colorBalance: { dominantCast: string } } };
  assert.equal(analysis.signals.colorBalance.dominantCast, 'red');
});

test('camera agent: a declined capture becomes a structured status, not a thrown error', async () => {
  const provider: CaptureProvider = {
    async capture(): Promise<CaptureOutcome> {
      return { status: 'declined', reason: 'user dismissed the camera prompt' };
    }
  };
  const agent = new CameraDiagnosticAgent({ captureProvider: provider, manifestProvider: () => manifest() });

  const result = await agent.runTurn(
    { sessionId: 's1', turnSeq: 4, message: JSON.stringify({ task: 'capture', target: 'scene' }) },
    noopContext()
  );

  const output = result.output as Record<string, unknown>;
  assert.equal(output.status, 'declined');
  assert.equal(output.reason, 'user dismissed the camera prompt');
  assert.ok(!('analysis' in output));
});

test('camera agent: a capture source outside the manifest is refused as out of scope', async () => {
  let captureCalls = 0;
  const provider: CaptureProvider = {
    async capture() {
      captureCalls++;
      return { status: 'declined', reason: 'unused' };
    }
  };
  const agent = new CameraDiagnosticAgent({
    captureProvider: provider,
    manifestProvider: () => manifest({ captureSources: ['environment'] })
  });

  const result = await agent.runTurn(
    { sessionId: 's1', turnSeq: 5, message: JSON.stringify({ task: 'capture', target: 'selfie', source: 'user' }) },
    noopContext()
  );

  assert.equal(captureCalls, 0);
  const output = result.output as Record<string, unknown>;
  assert.equal(output.status, 'unavailable');
});

test('camera agent: a plain-language task is treated as an environment capture with the text as reason', async () => {
  let seenReason: string | undefined;
  const provider = createAnalyzerCaptureProvider(new CanvasHeuristicAnalyzer(), async (request) => {
    seenReason = request.reason;
    return { status: 'captured', captured: { frame: solidFrame([120, 120, 120]), source: request.source, sampleSource: 'simulated' } };
  });
  const agent = new CameraDiagnosticAgent({ captureProvider: provider, manifestProvider: () => manifest() });

  const result = await agent.runTurn(
    { sessionId: 's1', turnSeq: 6, message: 'Point the camera at the error light on the router' },
    noopContext()
  );

  assert.equal(seenReason, 'Point the camera at the error light on the router');
  const output = result.output as Record<string, unknown>;
  assert.equal(output.status, 'captured');
  assert.equal(output.source, 'environment');
});
