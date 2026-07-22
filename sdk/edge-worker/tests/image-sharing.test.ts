import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maybeShareImage, type ImageEncoder } from '../src/analysis/image-sharing';
import type { EdgeFrame } from '../src/analysis/frame-analyzer';

function solidFrame(width: number, height: number, rgb: [number, number, number] = [120, 130, 140]): EdgeFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function recordingEncoder(): ImageEncoder & { last?: EdgeFrame } {
  const encoder: ImageEncoder & { last?: EdgeFrame } = {
    mimeType: 'image/jpeg',
    async encode(frame: EdgeFrame) {
      encoder.last = frame;
      return { dataUrl: 'data:image/jpeg;base64,AAAA', bytes: 3 };
    }
  };
  return encoder;
}

test('image sharing: policy off never produces an image, even with consent', async () => {
  const artifact = await maybeShareImage(solidFrame(20, 20), { consent: true }, { policy: 'off', encoder: recordingEncoder() });
  assert.equal(artifact, undefined);
});

test('image sharing: without explicit consent no image is produced', async () => {
  const artifact = await maybeShareImage(
    solidFrame(20, 20),
    { consent: false },
    { policy: 'on-explicit-consent', encoder: recordingEncoder() }
  );
  assert.equal(artifact, undefined);
});

test('image sharing: with policy on but no encoder wired, nothing can be shared', async () => {
  const artifact = await maybeShareImage(solidFrame(20, 20), { consent: true }, { policy: 'on-explicit-consent' });
  assert.equal(artifact, undefined);
});

test('image sharing: consent + encoder crops, masks, downscales, then encodes the processed frame', async () => {
  const encoder = recordingEncoder();
  const artifact = await maybeShareImage(
    solidFrame(400, 400),
    { consent: true, scope: 'router label', crop: { x: 100, y: 100, width: 200, height: 200 }, mask: [{ x: 0, y: 0, width: 50, height: 50 }], maxEdge: 100 },
    { policy: 'on-explicit-consent', encoder },
    () => '2026-01-01T00:00:00Z'
  );
  assert.ok(artifact);
  assert.equal(artifact.encoding, 'image/jpeg');
  assert.equal(artifact.consent.consented, true);
  assert.equal(artifact.consent.scope, 'router label');
  assert.equal(artifact.consent.grantedAt, '2026-01-01T00:00:00Z');
  assert.equal(artifact.processing.cropped, true);
  assert.equal(artifact.processing.downscaled, true);
  assert.equal(artifact.processing.maskedRegions, 1);
  // Cropped to 200, then downscaled to a 100 longest edge.
  assert.equal(artifact.width, 100);
  assert.equal(artifact.height, 100);
  assert.equal(encoder.last?.width, 100);
});

test('image sharing: an untouched consented frame reports no crop/downscale when it already fits', async () => {
  const artifact = await maybeShareImage(
    solidFrame(64, 64),
    { consent: true },
    { policy: 'on-explicit-consent', encoder: recordingEncoder(), defaultMaxEdge: 256 }
  );
  assert.ok(artifact);
  assert.equal(artifact.processing.cropped, false);
  assert.equal(artifact.processing.downscaled, false);
  assert.equal(artifact.processing.maskedRegions, 0);
});
