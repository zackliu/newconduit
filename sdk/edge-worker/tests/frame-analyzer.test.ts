import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CanvasHeuristicAnalyzer, type EdgeFrame } from '../src/analysis/frame-analyzer';

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

const analyzer = new CanvasHeuristicAnalyzer();

test('analyzer: a sharp high-frequency frame scores far higher focus than a flat blurry frame', () => {
  const checker = makeFrame(64, 64, (x, y) => {
    const on = (x + y) % 2 === 0;
    const v = on ? 220 : 30;
    return [v, v, v];
  });
  const flat = makeFrame(64, 64, () => [128, 128, 128]);

  const sharp = analyzer.analyze(checker);
  const blurry = analyzer.analyze(flat);

  assert.ok(
    sharp.signals.sharpness.laplacianVariance > blurry.signals.sharpness.laplacianVariance,
    'checkerboard should have higher Laplacian variance than a flat frame'
  );
  assert.ok(sharp.signals.sharpness.focusScore > blurry.signals.sharpness.focusScore);
  assert.equal(blurry.signals.sharpness.focusScore, 0);
  assert.ok(blurry.findings.some((f) => f.code === 'out_of_focus'));
});

test('analyzer: brightness ordering and exposure findings track pixel luma', () => {
  const dark = analyzer.analyze(makeFrame(48, 48, () => [8, 8, 8]));
  const mid = analyzer.analyze(makeFrame(48, 48, () => [130, 130, 130]));
  const bright = analyzer.analyze(makeFrame(48, 48, () => [252, 252, 252]));

  assert.ok(dark.signals.brightness.normalized < mid.signals.brightness.normalized);
  assert.ok(mid.signals.brightness.normalized < bright.signals.brightness.normalized);
  assert.ok(dark.findings.some((f) => f.code === 'underexposed'));
  assert.ok(bright.findings.some((f) => f.code === 'overbright' || f.code === 'blown_highlights'));
});

test('analyzer: a red-dominant frame is reported as a warm red colour cast', () => {
  const warm = analyzer.analyze(makeFrame(40, 40, () => [210, 120, 70]));
  assert.equal(warm.signals.colorBalance.dominantCast, 'red');
  assert.equal(warm.signals.colorBalance.temperatureLabel, 'warm');
  assert.ok(warm.signals.colorBalance.warmthRatio > 1.15);
  assert.ok(warm.findings.some((f) => f.code === 'color_cast'));

  const cool = analyzer.analyze(makeFrame(40, 40, () => [70, 120, 210]));
  assert.equal(cool.signals.colorBalance.dominantCast, 'blue');
  assert.equal(cool.signals.colorBalance.temperatureLabel, 'cool');
});

test('analyzer: a large white block is detected as a glare hotspot', () => {
  const glare = makeFrame(60, 60, (x, y) => {
    const inHotspot = x >= 15 && x < 45 && y >= 15 && y < 45;
    return inHotspot ? [255, 255, 255] : [90, 90, 90];
  });
  const analysis = analyzer.analyze(glare);
  assert.ok(analysis.signals.glare.hotspotPct > 8);
  assert.ok(analysis.findings.some((f) => f.code === 'glare'));
});

test('analyzer: output is bounded structured evidence and never echoes raw pixels', () => {
  const analysis = analyzer.analyze(makeFrame(32, 32, () => [120, 120, 120]));
  const serialized = JSON.stringify(analysis);
  assert.ok(!('data' in (analysis as unknown as Record<string, unknown>)));
  assert.ok(!serialized.includes('"data"'));
  assert.equal(typeof analysis.qualityScore, 'number');
  assert.ok(analysis.qualityScore >= 0 && analysis.qualityScore <= 100);
  assert.equal(analysis.analyzer, 'canvas-heuristic-v1');
});

test('analyzer: rejects frames whose buffer is smaller than width*height*4', () => {
  assert.throws(() => analyzer.analyze({ data: new Uint8ClampedArray(4), width: 10, height: 10 }));
});
