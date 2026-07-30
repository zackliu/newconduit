import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cropFrame, downscaleFrame, maskRegions, clampRect } from '../src/analysis/frame-processing';
import type { EdgeFrame } from '../src/analysis/frame-analyzer';

function makeFrame(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): EdgeFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const [r, g, b] = fill(x, y);
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  return { data, width, height };
}

function pixel(frame: EdgeFrame, x: number, y: number): [number, number, number] {
  const i = (y * frame.width + x) * 4;
  return [frame.data[i], frame.data[i + 1], frame.data[i + 2]];
}

test('cropFrame: extracts the requested region and preserves its pixels', () => {
  const frame = makeFrame(10, 10, (x) => (x < 5 ? [10, 10, 10] : [200, 200, 200]));
  const cropped = cropFrame(frame, { x: 5, y: 0, width: 5, height: 10 });
  assert.equal(cropped.width, 5);
  assert.equal(cropped.height, 10);
  assert.deepEqual(pixel(cropped, 0, 0), [200, 200, 200]);
});

test('cropFrame: clamps out-of-bounds rects and throws when the result is empty', () => {
  const frame = makeFrame(8, 8, () => [50, 60, 70]);
  const clamped = cropFrame(frame, { x: 4, y: 4, width: 100, height: 100 });
  assert.equal(clamped.width, 4);
  assert.equal(clamped.height, 4);
  assert.throws(() => cropFrame(frame, { x: 20, y: 20, width: 5, height: 5 }));
});

test('downscaleFrame: bounds the longest edge and returns a copy when already small', () => {
  const big = makeFrame(200, 100, () => [128, 128, 128]);
  const small = downscaleFrame(big, 50);
  assert.equal(small.width, 50);
  assert.equal(small.height, 25);

  const already = makeFrame(40, 40, () => [1, 2, 3]);
  const copy = downscaleFrame(already, 64);
  assert.equal(copy.width, 40);
  assert.notEqual(copy.data, already.data, 'must return a copy, not the same buffer');
});

test('maskRegions: blackout zeroes the region, leaves the rest, and does not mutate the input', () => {
  const frame = makeFrame(10, 10, () => [222, 111, 55]);
  const masked = maskRegions(frame, [{ x: 2, y: 2, width: 4, height: 4 }], { mode: 'blackout' });
  assert.deepEqual(pixel(masked, 3, 3), [0, 0, 0], 'inside the mask is blacked out');
  assert.deepEqual(pixel(masked, 0, 0), [222, 111, 55], 'outside the mask is unchanged');
  assert.deepEqual(pixel(frame, 3, 3), [222, 111, 55], 'the original frame is not mutated');
});

test('maskRegions: pixelate averages the region toward its block mean', () => {
  const frame = makeFrame(16, 16, (x) => (x % 2 === 0 ? [0, 0, 0] : [200, 200, 200]));
  const masked = maskRegions(frame, [{ x: 0, y: 0, width: 16, height: 16 }], { mode: 'pixelate', blockSize: 8 });
  const [r] = pixel(masked, 3, 3);
  assert.ok(r > 40 && r < 160, `pixelated value ${r} should be a block average, not a hard 0/200`);
});

test('clampRect: keeps rectangles within the frame bounds', () => {
  assert.deepEqual(clampRect({ x: -5, y: -5, width: 20, height: 20 }, 10, 10), { x: 0, y: 0, width: 10, height: 10 });
});
