import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CameraDiagnosticAgent,
  type EdgeDeviceManifest
} from '../src/analysis/camera-diagnostic-agent';
import { createAnalyzerCaptureProvider } from '../src/analysis/frame-capture-provider';
import { CanvasHeuristicAnalyzer, type EdgeFrame } from '../src/analysis/frame-analyzer';
import { LedIndicatorAnalyzer } from '../src/analysis/led-indicator-analyzer';
import { createCodeObserver, type CodeScanner } from '../src/analysis/code-scanner';
import type { ImageEncoder } from '../src/analysis/image-sharing';
import type { EdgeAgentContext } from '../src/edge-agent';

function noopContext(): EdgeAgentContext {
  return { progress: () => undefined, delta: () => undefined, signal: new AbortController().signal };
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

function frameWithRedBlob(): EdgeFrame {
  const width = 48;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBlob = x >= 18 && x < 30 && y >= 18 && y < 30;
      const idx = (y * width + x) * 4;
      data[idx] = inBlob ? 235 : 15;
      data[idx + 1] = inBlob ? 25 : 15;
      data[idx + 2] = inBlob ? 25 : 15;
      data[idx + 3] = 255;
    }
  }
  return { data, width, height };
}

const fakeCodeScanner: CodeScanner = {
  id: 'fake-scanner',
  async scan() {
    return { supported: true, codes: [{ format: 'qr_code', value: 'MODEL-XR20' }] };
  }
};

test('capture with observers: LED + code observations ride along the structured evidence, no pixels', async () => {
  const provider = createAnalyzerCaptureProvider(
    new CanvasHeuristicAnalyzer(),
    async () => ({ status: 'captured', captured: { frame: frameWithRedBlob(), source: 'environment', sampleSource: 'camera' } }),
    { observers: [new LedIndicatorAnalyzer(), createCodeObserver(fakeCodeScanner)] }
  );
  const agent = new CameraDiagnosticAgent({ captureProvider: provider, manifestProvider: () => manifest() });

  const result = await agent.runTurn(
    { sessionId: 's1', turnSeq: 1, message: JSON.stringify({ task: 'capture', target: 'status panel' }) },
    noopContext()
  );

  const output = result.output as Record<string, unknown>;
  assert.equal(output.kind, 'device-evidence');
  assert.equal(output.imageShared, false);
  const observations = output.observations as Array<{ kind: string }>;
  assert.ok(observations.some((o) => o.kind === 'led-indicator'), 'LED observation present');
  assert.ok(observations.some((o) => o.kind === 'code'), 'code observation present');
  assert.ok(!JSON.stringify(result).includes('"data"'), 'no raw RGBA buffer leaves the device');
  assert.equal(output.privacy, 'raw-frame-retained-on-device');
});

test('capture detect filter: only the requested observer kind runs', async () => {
  const provider = createAnalyzerCaptureProvider(
    new CanvasHeuristicAnalyzer(),
    async () => ({ status: 'captured', captured: { frame: frameWithRedBlob(), source: 'environment', sampleSource: 'camera' } }),
    { observers: [new LedIndicatorAnalyzer(), createCodeObserver(fakeCodeScanner)] }
  );
  const agent = new CameraDiagnosticAgent({ captureProvider: provider, manifestProvider: () => manifest() });

  const result = await agent.runTurn(
    { sessionId: 's1', turnSeq: 2, message: JSON.stringify({ task: 'capture', target: 'panel', detect: ['code'] }) },
    noopContext()
  );

  const observations = (result.output as Record<string, unknown>).observations as Array<{ kind: string }>;
  assert.equal(observations.length, 1);
  assert.equal(observations[0].kind, 'code');
});

test('consent gate: no image is shared by default, even when the remote task claims consent', async () => {
  const encoderCalls = { count: 0 };
  const encoder: ImageEncoder = {
    mimeType: 'image/jpeg',
    async encode() {
      encoderCalls.count++;
      return { dataUrl: 'data:image/jpeg;base64,AAAA', bytes: 3 };
    }
  };
  // No imageSharing config on the provider => sharing disabled regardless of the request.
  const provider = createAnalyzerCaptureProvider(
    new CanvasHeuristicAnalyzer(),
    async () => ({ status: 'captured', captured: { frame: frameWithRedBlob(), source: 'environment', sampleSource: 'camera' } }),
    { imageSharing: { policy: 'on-explicit-consent', encoder } }
  );
  const agent = new CameraDiagnosticAgent({ captureProvider: provider, manifestProvider: () => manifest() });

  const result = await agent.runTurn(
    { sessionId: 's1', turnSeq: 3, message: JSON.stringify({ task: 'capture', target: 'panel', share: { consent: true } }) },
    noopContext()
  );

  const output = result.output as Record<string, unknown>;
  assert.equal(output.imageShared, false);
  assert.ok(!('sharedImage' in output));
  assert.equal(encoderCalls.count, 0);
  void encoder;
});

test('consent gate: a locally approved capture attaches a processed image and flags the privacy change', async () => {
  const encoder: ImageEncoder = {
    mimeType: 'image/jpeg',
    async encode(frame) {
      return { dataUrl: 'data:image/jpeg;base64,AAAA', bytes: frame.width * frame.height };
    }
  };
  const provider = createAnalyzerCaptureProvider(
    new CanvasHeuristicAnalyzer(),
    async () => ({
      status: 'captured',
      captured: {
        frame: frameWithRedBlob(),
        source: 'environment',
        sampleSource: 'camera',
        imageShareAuthorization: {
          granted: true,
          scope: 'device label',
          grantedAt: '2026-01-01T00:00:00Z'
        }
      }
    }),
    { imageSharing: { policy: 'on-explicit-consent', encoder, defaultMaxEdge: 256 } }
  );
  const agent = new CameraDiagnosticAgent({
    captureProvider: provider,
    manifestProvider: () => manifest({ imageSharing: { policy: 'on-explicit-consent' } })
  });

  const result = await agent.runTurn(
    {
      sessionId: 's1',
      turnSeq: 4,
      message: JSON.stringify({ task: 'capture', target: 'label', share: { scope: 'device label' } })
    },
    noopContext()
  );

  const output = result.output as Record<string, unknown>;
  assert.equal(output.imageShared, true);
  assert.equal(output.privacy, 'processed-image-shared-with-consent');
  const shared = output.sharedImage as { consent: { consented: boolean; scope: string }; encoding: string };
  assert.equal(shared.consent.consented, true);
  assert.equal(shared.consent.scope, 'device label');
  assert.equal(shared.encoding, 'image/jpeg');
});
