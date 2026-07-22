import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserBarcodeScanner, createCodeObserver, type CodeScanner } from '../src/analysis/code-scanner';
import type { EdgeFrame } from '../src/analysis/frame-analyzer';
import type { CodeObservation } from '../src/analysis/local-observers';

function blankFrame(): EdgeFrame {
  return { data: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8 };
}

test('code observer: decoded codes are reported as a structured, image-free observation', async () => {
  const scanner: CodeScanner = {
    id: 'fake-scanner',
    async scan() {
      return {
        supported: true,
        codes: [{ format: 'qr_code', value: 'SN:ABC-123', box: { x: 1, y: 2, width: 3, height: 4 } }]
      };
    }
  };
  const observer = createCodeObserver(scanner);
  assert.equal(observer.kind, 'code');

  const observation = (await observer.observe(blankFrame(), { capturedAt: '2026-01-01T00:00:00Z' })) as CodeObservation;
  assert.equal(observation.kind, 'code');
  assert.equal(observation.supported, true);
  assert.equal(observation.codes.length, 1);
  assert.equal(observation.codes[0].value, 'SN:ABC-123');
  assert.match(observation.summary, /decoded/i);
  assert.ok(!JSON.stringify(observation).includes('"data"'), 'observation must not carry pixels');
});

test('code observer: an unsupported scanner is reported honestly, not faked', async () => {
  const scanner: CodeScanner = {
    id: 'unsupported',
    async scan() {
      return { supported: false, codes: [] };
    }
  };
  const observation = (await createCodeObserver(scanner).observe(blankFrame(), { capturedAt: 'now' })) as CodeObservation;
  assert.equal(observation.supported, false);
  assert.equal(observation.codes.length, 0);
  assert.match(observation.summary, /not available/i);
});

test('browser scanner: reports unsupported when BarcodeDetector is absent (e.g. Node)', async () => {
  const result = await new BrowserBarcodeScanner().scan(blankFrame());
  assert.equal(result.supported, false);
  assert.deepEqual(result.codes, []);
});

test('browser scanner: uses an injected BarcodeDetector global when present', async () => {
  const globals = globalThis as Record<string, unknown>;
  const originalDetector = globals.BarcodeDetector;
  const originalImageData = globals.ImageData;
  globals.ImageData = class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  };
  globals.BarcodeDetector = class {
    async detect() {
      return [{ rawValue: 'https://example.test/manual', format: 'qr_code', boundingBox: { x: 0, y: 0, width: 8, height: 8 } }];
    }
  };
  try {
    const result = await new BrowserBarcodeScanner().scan(blankFrame());
    assert.equal(result.supported, true);
    assert.equal(result.codes[0].value, 'https://example.test/manual');
    assert.equal(result.codes[0].format, 'qr_code');
  } finally {
    globals.BarcodeDetector = originalDetector;
    globals.ImageData = originalImageData;
  }
});
