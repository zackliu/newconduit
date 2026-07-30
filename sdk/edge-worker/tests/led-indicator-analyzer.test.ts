import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LedIndicatorAnalyzer, LedBlinkTracker } from '../src/analysis/led-indicator-analyzer';
import type { EdgeFrame } from '../src/analysis/frame-analyzer';

function frameWithBlob(bg: [number, number, number], blob: [number, number, number], rect: { x: number; y: number; w: number; h: number }): EdgeFrame {
  const width = 64;
  const height = 64;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inBlob = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      const [r, g, b] = inBlob ? blob : bg;
      const idx = (y * width + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  return { data, width, height };
}

const analyzer = new LedIndicatorAnalyzer();

test('led analyzer: a bright red blob on a dark face is detected as a lit red indicator', () => {
  const frame = frameWithBlob([15, 15, 15], [235, 25, 25], { x: 26, y: 26, w: 12, h: 12 });
  const observation = analyzer.detect(frame);
  assert.equal(observation.kind, 'led-indicator');
  assert.equal(observation.indicators.length, 1);
  assert.equal(observation.indicators[0].color, 'red');
  assert.equal(observation.indicators[0].state, 'on');
  assert.ok(observation.indicators[0].areaPct > 0);
});

test('led analyzer: colour classification distinguishes green and blue from red', () => {
  const green = analyzer.detect(frameWithBlob([15, 15, 15], [25, 210, 40], { x: 20, y: 20, w: 14, h: 14 }));
  const blue = analyzer.detect(frameWithBlob([15, 15, 15], [30, 40, 220], { x: 20, y: 20, w: 14, h: 14 }));
  assert.equal(green.indicators[0].color, 'green');
  assert.equal(blue.indicators[0].color, 'blue');
});

test('led analyzer: a flat unlit scene reports no indicators', () => {
  const dark = analyzer.detect(frameWithBlob([20, 20, 20], [20, 20, 20], { x: 0, y: 0, w: 1, h: 1 }));
  assert.equal(dark.indicators.length, 0);
  assert.match(dark.summary, /No lit indicator/i);
});

test('led analyzer: a bright low-saturation (white/glare) region is not misreported as a colour LED', () => {
  const white = analyzer.detect(frameWithBlob([15, 15, 15], [245, 245, 248], { x: 24, y: 24, w: 16, h: 16 }));
  // Low saturation is excluded from the coloured-indicator mask, so no red/green/blue false positive.
  assert.ok(white.indicators.every((i) => i.color !== 'red' && i.color !== 'green' && i.color !== 'blue'));
});

test('led analyzer: observation carries no raw pixel buffer', () => {
  const observation = analyzer.detect(frameWithBlob([15, 15, 15], [235, 25, 25], { x: 26, y: 26, w: 12, h: 12 }));
  const serialized = JSON.stringify(observation);
  assert.ok(!serialized.includes('"data"'));
});

test('blink tracker: alternating presence is blinking, constant presence is steady', () => {
  const blink = new LedBlinkTracker(6);
  [true, false, true, false].forEach((s) => blink.record(s));
  assert.equal(blink.state(), 'blinking');

  const steady = new LedBlinkTracker(6);
  [true, true, true].forEach((s) => steady.record(s));
  assert.equal(steady.state(), 'steady-on');

  const off = new LedBlinkTracker(6);
  [false, false].forEach((s) => off.record(s));
  assert.equal(off.state(), 'steady-off');

  assert.equal(new LedBlinkTracker().state(), 'unknown');
});
