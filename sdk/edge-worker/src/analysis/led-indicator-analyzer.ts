/**
 * LED / indicator-light analysis. This is honest, verifiable local computation: it finds bright, saturated blobs
 * (the way a lit status LED appears against a darker device face), groups them with connected-component labelling,
 * and classifies each blob's colour from its mean RGB. It does NOT interpret meaning ("red = fault") — that
 * mapping depends on the specific device and is left to the cloud agent + manuals. `LedBlinkTracker` turns a
 * sequence of per-capture presence samples into a steady/blinking classification, since blink rate needs time,
 * not a single frame.
 */

import type { EdgeFrame } from './frame-analyzer';
import type {
  DeviceObservation,
  LedIndicator,
  LedIndicatorObservation,
  LocalObserver,
  ObserverContext
} from './local-observers';

export interface LedIndicatorOptions {
  /** Minimum dominant channel value (0..255) for a pixel to count as "lit". Default 150. */
  minChannel?: number;
  /** Minimum saturation (0..1) for a pixel to count as a coloured indicator. Default 0.33. */
  minSaturation?: number;
  /** Minimum blob coverage (percent of frame) to report. Default 0.02. */
  minAreaPct?: number;
  /** Upper bound on sampled pixels; larger frames are strided down. Default 200_000. */
  maxSampledPixels?: number;
  /** Cap on the number of reported indicators (largest first). Default 8. */
  maxIndicators?: number;
}

const DEFAULTS: Required<LedIndicatorOptions> = {
  minChannel: 150,
  minSaturation: 0.33,
  minAreaPct: 0.02,
  maxSampledPixels: 200_000,
  maxIndicators: 8
};

function round(value: number, decimals = 3): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function classifyColor(r: number, g: number, b: number): LedIndicator['color'] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (max < 60) return 'unknown';
  if (sat < 0.25) return max >= 160 ? 'white' : 'unknown';
  if (b === max && b - Math.max(r, g) > 8) return 'blue';
  if (g === max && g - Math.max(r, b) > 8) {
    return r >= 0.65 * g && b < 0.55 * g ? 'amber' : 'green';
  }
  if (r === max) {
    return g >= 0.4 * r && b < 0.55 * r ? 'amber' : 'red';
  }
  return 'unknown';
}

interface Blob {
  cells: number;
  sumR: number;
  sumG: number;
  sumB: number;
  sumX: number;
  sumY: number;
}

export class LedIndicatorAnalyzer implements LocalObserver {
  readonly id = 'led-indicator-v1';
  readonly kind = 'led-indicator';
  readonly displayName = 'LED indicator analyzer';
  private readonly options: Required<LedIndicatorOptions>;

  constructor(options: LedIndicatorOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  observe(frame: EdgeFrame, context: ObserverContext): DeviceObservation {
    void context;
    return this.detect(frame);
  }

  detect(frame: EdgeFrame): LedIndicatorObservation {
    const { width, height, data } = frame;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error('frame width and height must be positive integers');
    }
    if (data.length < width * height * 4) {
      throw new Error('frame data is smaller than width * height * 4 (expected RGBA)');
    }

    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / this.options.maxSampledPixels)));
    const sw = Math.floor((width + step - 1) / step);
    const sh = Math.floor((height + step - 1) / step);
    const total = sw * sh;

    // Per grid-cell indicator mask + colour, so blobs can be labelled and averaged.
    const lit = new Uint8Array(total);
    const cellR = new Float64Array(total);
    const cellG = new Float64Array(total);
    const cellB = new Float64Array(total);

    let gy = 0;
    for (let y = 0; y < height; y += step, gy++) {
      let gx = 0;
      for (let x = 0; x < width; x += step, gx++) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const gi = gy * sw + gx;
        if (max >= this.options.minChannel && sat >= this.options.minSaturation) {
          lit[gi] = 1;
          cellR[gi] = r;
          cellG[gi] = g;
          cellB[gi] = b;
        }
      }
    }

    const blobs = this.labelBlobs(lit, cellR, cellG, cellB, sw, sh);
    const minCells = Math.max(3, Math.ceil((this.options.minAreaPct / 100) * total));

    const indicators: LedIndicator[] = blobs
      .filter((blob) => blob.cells >= minCells)
      .sort((a, b) => b.cells - a.cells)
      .slice(0, this.options.maxIndicators)
      .map((blob) => {
        const meanR = blob.sumR / blob.cells;
        const meanG = blob.sumG / blob.cells;
        const meanB = blob.sumB / blob.cells;
        return {
          color: classifyColor(meanR, meanG, meanB),
          state: 'on',
          areaPct: round((blob.cells / total) * 100, 2),
          centroid: {
            x: round((blob.sumX / blob.cells) * step / width),
            y: round((blob.sumY / blob.cells) * step / height)
          },
          meanRgb: [Math.round(meanR), Math.round(meanG), Math.round(meanB)]
        };
      });

    return {
      kind: 'led-indicator',
      detector: this.id,
      indicators,
      summary: this.summarize(indicators)
    };
  }

  private labelBlobs(
    lit: Uint8Array,
    cellR: Float64Array,
    cellG: Float64Array,
    cellB: Float64Array,
    sw: number,
    sh: number
  ): Blob[] {
    const total = sw * sh;
    const visited = new Uint8Array(total);
    const stack: number[] = [];
    const blobs: Blob[] = [];
    for (let start = 0; start < total; start++) {
      if (visited[start] || !lit[start]) continue;
      const blob: Blob = { cells: 0, sumR: 0, sumG: 0, sumB: 0, sumX: 0, sumY: 0 };
      stack.push(start);
      visited[start] = 1;
      while (stack.length > 0) {
        const p = stack.pop()!;
        const x = p % sw;
        const y = (p - x) / sw;
        blob.cells++;
        blob.sumR += cellR[p];
        blob.sumG += cellG[p];
        blob.sumB += cellB[p];
        blob.sumX += x;
        blob.sumY += y;
        if (x > 0 && !visited[p - 1] && lit[p - 1]) { visited[p - 1] = 1; stack.push(p - 1); }
        if (x < sw - 1 && !visited[p + 1] && lit[p + 1]) { visited[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && !visited[p - sw] && lit[p - sw]) { visited[p - sw] = 1; stack.push(p - sw); }
        if (y < sh - 1 && !visited[p + sw] && lit[p + sw]) { visited[p + sw] = 1; stack.push(p + sw); }
      }
      blobs.push(blob);
    }
    return blobs;
  }

  private summarize(indicators: LedIndicator[]): string {
    if (indicators.length === 0) {
      return 'No lit indicator detected.';
    }
    const byColor = indicators.map((i) => i.color).join(', ');
    return `${indicators.length} lit indicator${indicators.length === 1 ? '' : 's'} detected (${byColor}).`;
  }
}

export type BlinkState = 'steady-on' | 'steady-off' | 'blinking' | 'unknown';

/**
 * Classifies whether an indicator is steady or blinking from a rolling window of presence samples across
 * successive captures. A single frame can never tell you this; the caller feeds it one boolean per capture.
 */
export class LedBlinkTracker {
  private readonly samples: boolean[] = [];
  private readonly windowSize: number;

  constructor(windowSize = 8) {
    this.windowSize = Math.max(2, windowSize);
  }

  record(present: boolean): void {
    this.samples.push(present);
    if (this.samples.length > this.windowSize) {
      this.samples.shift();
    }
  }

  state(): BlinkState {
    if (this.samples.length < 2) return 'unknown';
    let transitions = 0;
    for (let i = 1; i < this.samples.length; i++) {
      if (this.samples[i] !== this.samples[i - 1]) transitions++;
    }
    if (transitions >= 2) return 'blinking';
    return this.samples[this.samples.length - 1] ? 'steady-on' : 'steady-off';
  }

  reset(): void {
    this.samples.length = 0;
  }
}
