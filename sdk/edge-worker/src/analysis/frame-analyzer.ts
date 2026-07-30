/**
 * Local edge inference for the browser worker.
 *
 * `FrameAnalyzer` is the model-adapter seam: the default `CanvasHeuristicAnalyzer` computes real optical
 * signals from raw RGBA pixels with bounded, deterministic arithmetic (no model download, no network). A
 * future WebGPU / ONNX / WebNN analyzer can implement the same interface without changing the worker or
 * the console. This is honest local computation, not a simulated vision-language model.
 */

/** RGBA pixel buffer, structurally compatible with the browser `ImageData`. */
export interface EdgeFrame {
  data: Uint8ClampedArray | Uint8Array | number[];
  width: number;
  height: number;
}

export type SignalSeverity = 'ok' | 'info' | 'warn' | 'issue';

export interface FrameFinding {
  code: string;
  severity: SignalSeverity;
  label: string;
  detail: string;
}

export interface FrameSignals {
  resolution: { width: number; height: number; megapixels: number };
  brightness: { meanLuma: number; normalized: number };
  exposure: { clippedHighlightsPct: number; clippedShadowsPct: number; dynamicRange: number };
  contrast: { lumaStdDev: number; normalized: number };
  colorBalance: {
    meanR: number;
    meanG: number;
    meanB: number;
    warmthRatio: number;
    dominantCast: 'red' | 'green' | 'blue' | 'neutral';
    temperatureLabel: 'warm' | 'cool' | 'neutral';
    estimatedKelvin: number;
  };
  saturation: { meanSaturation: number };
  sharpness: { laplacianVariance: number; focusScore: number };
  glare: { brightPixelPct: number; hotspotPct: number };
}

export interface FrameAnalysis {
  analyzer: string;
  capturedAt: string;
  sampledPixels: number;
  signals: FrameSignals;
  findings: FrameFinding[];
  qualityScore: number;
  summary: string;
  recommendation: string;
}

export interface FrameAnalyzeOptions {
  /** ISO timestamp for the capture; defaults to now. */
  capturedAt?: string;
  /** Upper bound on sampled pixels; larger frames are strided down. Keeps analysis bounded. */
  maxSampledPixels?: number;
}

export interface FrameAnalyzer {
  readonly id: string;
  readonly displayName: string;
  analyze(frame: EdgeFrame, options?: FrameAnalyzeOptions): FrameAnalysis;
}

const DEFAULT_MAX_SAMPLED_PIXELS = 300_000;

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export class CanvasHeuristicAnalyzer implements FrameAnalyzer {
  readonly id = 'canvas-heuristic-v1';
  readonly displayName = 'Canvas heuristic analyzer';

  analyze(frame: EdgeFrame, options: FrameAnalyzeOptions = {}): FrameAnalysis {
    const { width, height, data } = frame;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
      throw new Error('frame width and height must be positive integers');
    }
    if (data.length < width * height * 4) {
      throw new Error('frame data is smaller than width * height * 4 (expected RGBA)');
    }

    const maxSampled = options.maxSampledPixels ?? DEFAULT_MAX_SAMPLED_PIXELS;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / maxSampled)));
    const sw = Math.floor((width + step - 1) / step);
    const sh = Math.floor((height + step - 1) / step);

    const luma = new Float64Array(sw * sh);
    let sumLuma = 0;
    let sumLumaSq = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let sumSaturation = 0;
    let clippedHigh = 0;
    let clippedLow = 0;
    let brightPixels = 0;
    let minLuma = 255;
    let maxLuma = 0;
    let count = 0;

    let gi = 0;
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        luma[gi++] = l;
        sumLuma += l;
        sumLumaSq += l * l;
        sumR += r;
        sumG += g;
        sumB += b;
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        sumSaturation += max === 0 ? 0 : (max - min) / max;
        if (l >= 250) clippedHigh++;
        if (l <= 5) clippedLow++;
        if (l >= 235) brightPixels++;
        if (l < minLuma) minLuma = l;
        if (l > maxLuma) maxLuma = l;
        count++;
      }
    }

    const meanLuma = sumLuma / count;
    const variance = Math.max(0, sumLumaSq / count - meanLuma * meanLuma);
    const stdDev = Math.sqrt(variance);
    const meanR = sumR / count;
    const meanG = sumG / count;
    const meanB = sumB / count;
    const meanSaturation = sumSaturation / count;

    const laplacianVariance = this.laplacianVariance(luma, sw, sh);
    const focusScore = clamp01(laplacianVariance / 260);

    const hotspotPct = this.largestBrightHotspotPct(luma, sw, sh);
    const brightPixelPct = (brightPixels / count) * 100;

    const warmthRatio = meanR / (meanB + 1);
    const dominantCast = this.dominantCast(meanR, meanG, meanB);
    const temperatureLabel: 'warm' | 'cool' | 'neutral' =
      warmthRatio > 1.15 ? 'warm' : warmthRatio < 0.87 ? 'cool' : 'neutral';
    const estimatedKelvin = this.estimateKelvin(warmthRatio);

    const signals: FrameSignals = {
      resolution: { width, height, megapixels: round((width * height) / 1_000_000, 2) },
      brightness: { meanLuma: round(meanLuma, 1), normalized: round(meanLuma / 255, 3) },
      exposure: {
        clippedHighlightsPct: round((clippedHigh / count) * 100, 2),
        clippedShadowsPct: round((clippedLow / count) * 100, 2),
        dynamicRange: round(maxLuma - minLuma, 1)
      },
      contrast: { lumaStdDev: round(stdDev, 1), normalized: round(clamp01(stdDev / 80), 3) },
      colorBalance: {
        meanR: round(meanR, 1),
        meanG: round(meanG, 1),
        meanB: round(meanB, 1),
        warmthRatio: round(warmthRatio, 3),
        dominantCast,
        temperatureLabel,
        estimatedKelvin
      },
      saturation: { meanSaturation: round(meanSaturation, 3) },
      sharpness: { laplacianVariance: round(laplacianVariance, 1), focusScore: round(focusScore, 3) },
      glare: { brightPixelPct: round(brightPixelPct, 2), hotspotPct: round(hotspotPct, 2) }
    };

    const findings = this.deriveFindings(signals);
    const qualityScore = this.qualityScore(signals, focusScore);

    return {
      analyzer: this.id,
      capturedAt: options.capturedAt ?? new Date().toISOString(),
      sampledPixels: count,
      signals,
      findings,
      qualityScore,
      summary: this.summarize(signals, qualityScore),
      recommendation: this.recommend(findings)
    };
  }

  private laplacianVariance(luma: Float64Array, sw: number, sh: number): number {
    if (sw < 3 || sh < 3) {
      return 0;
    }
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const c = luma[y * sw + x];
        const lap = 4 * c - luma[y * sw + (x - 1)] - luma[y * sw + (x + 1)] - luma[(y - 1) * sw + x] - luma[(y + 1) * sw + x];
        sum += lap;
        sumSq += lap * lap;
        n++;
      }
    }
    if (n === 0) return 0;
    const mean = sum / n;
    return Math.max(0, sumSq / n - mean * mean);
  }

  private largestBrightHotspotPct(luma: Float64Array, sw: number, sh: number): number {
    // Fraction of the frame occupied by the largest connected near-white region (flood fill, 4-neighbour).
    const total = sw * sh;
    const visited = new Uint8Array(total);
    const stack: number[] = [];
    let largest = 0;
    for (let start = 0; start < total; start++) {
      if (visited[start] || luma[start] < 245) {
        continue;
      }
      let size = 0;
      stack.push(start);
      visited[start] = 1;
      while (stack.length > 0) {
        const p = stack.pop()!;
        size++;
        const x = p % sw;
        const y = (p - x) / sw;
        if (x > 0 && !visited[p - 1] && luma[p - 1] >= 245) { visited[p - 1] = 1; stack.push(p - 1); }
        if (x < sw - 1 && !visited[p + 1] && luma[p + 1] >= 245) { visited[p + 1] = 1; stack.push(p + 1); }
        if (y > 0 && !visited[p - sw] && luma[p - sw] >= 245) { visited[p - sw] = 1; stack.push(p - sw); }
        if (y < sh - 1 && !visited[p + sw] && luma[p + sw] >= 245) { visited[p + sw] = 1; stack.push(p + sw); }
      }
      if (size > largest) largest = size;
    }
    return (largest / total) * 100;
  }

  private dominantCast(r: number, g: number, b: number): 'red' | 'green' | 'blue' | 'neutral' {
    const mean = (r + g + b) / 3;
    if (mean === 0) return 'neutral';
    const dr = (r - mean) / mean;
    const dg = (g - mean) / mean;
    const db = (b - mean) / mean;
    const threshold = 0.12;
    const max = Math.max(dr, dg, db);
    if (max < threshold) return 'neutral';
    if (max === dr) return 'red';
    if (max === dg) return 'green';
    return 'blue';
  }

  private estimateKelvin(warmthRatio: number): number {
    // Coarse heuristic mapping of the red/blue balance to a correlated colour-temperature band. This is a
    // rough estimate for guidance only, not a calibrated measurement.
    const clamped = Math.max(0.6, Math.min(1.8, warmthRatio));
    const kelvin = 8000 - (clamped - 0.6) * (5000 / 1.2);
    return Math.round(kelvin / 100) * 100;
  }

  private deriveFindings(s: FrameSignals): FrameFinding[] {
    const findings: FrameFinding[] = [];
    const b = s.brightness.normalized;
    if (b < 0.18) {
      findings.push({ code: 'underexposed', severity: 'issue', label: 'Underexposed', detail: `Mean luma ${s.brightness.meanLuma} is very low; the scene is too dark to read detail.` });
    } else if (b < 0.30) {
      findings.push({ code: 'dim', severity: 'warn', label: 'Dim lighting', detail: `Mean luma ${s.brightness.meanLuma}; add light or move to a brighter area.` });
    } else if (b > 0.85) {
      findings.push({ code: 'overbright', severity: 'warn', label: 'Very bright', detail: `Mean luma ${s.brightness.meanLuma}; the frame is near the top of the range.` });
    }

    if (s.exposure.clippedHighlightsPct > 8) {
      findings.push({ code: 'blown_highlights', severity: 'warn', label: 'Blown highlights', detail: `${s.exposure.clippedHighlightsPct}% of pixels are clipped white; detail is lost in bright areas.` });
    }
    if (s.exposure.clippedShadowsPct > 12) {
      findings.push({ code: 'crushed_shadows', severity: 'warn', label: 'Crushed shadows', detail: `${s.exposure.clippedShadowsPct}% of pixels are clipped black.` });
    }

    if (s.sharpness.focusScore < 0.25) {
      findings.push({ code: 'out_of_focus', severity: 'issue', label: 'Out of focus', detail: `Focus score ${s.sharpness.focusScore} (Laplacian variance ${s.sharpness.laplacianVariance}); hold steady and refocus.` });
    } else if (s.sharpness.focusScore < 0.5) {
      findings.push({ code: 'soft_focus', severity: 'warn', label: 'Soft focus', detail: `Focus score ${s.sharpness.focusScore}; the frame is slightly soft.` });
    } else {
      findings.push({ code: 'in_focus', severity: 'ok', label: 'In focus', detail: `Focus score ${s.sharpness.focusScore}.` });
    }

    if (s.glare.hotspotPct > 8) {
      findings.push({ code: 'glare', severity: 'warn', label: 'Glare hotspot', detail: `A near-white region covers ${s.glare.hotspotPct}% of the frame; reduce reflections.` });
    }
    if (s.contrast.normalized < 0.08) {
      findings.push({ code: 'low_contrast', severity: 'warn', label: 'Low contrast', detail: `Luma standard deviation ${s.contrast.lumaStdDev}; the scene looks flat or fogged.` });
    }
    if (s.colorBalance.dominantCast !== 'neutral') {
      findings.push({ code: 'color_cast', severity: 'info', label: `${s.colorBalance.dominantCast} colour cast`, detail: `White balance skewed ${s.colorBalance.temperatureLabel} (warmth ratio ${s.colorBalance.warmthRatio}, ~${s.colorBalance.estimatedKelvin}K estimate).` });
    }
    return findings;
  }

  private qualityScore(s: FrameSignals, focusScore: number): number {
    const exposureScore = 1 - clamp01((s.exposure.clippedHighlightsPct + s.exposure.clippedShadowsPct) / 20);
    const brightnessScore = clamp01(1 - Math.abs(s.brightness.normalized - 0.5) / 0.5);
    const glareScore = 1 - clamp01(s.glare.hotspotPct / 15);
    const blended = 0.4 * focusScore + 0.25 * exposureScore + 0.2 * brightnessScore + 0.15 * glareScore;
    return Math.round(100 * clamp01(blended));
  }

  private summarize(s: FrameSignals, qualityScore: number): string {
    return `Captured ${s.resolution.width}x${s.resolution.height} frame. Quality ${qualityScore}/100 · focus ${s.sharpness.focusScore} · brightness ${s.brightness.normalized} · ${s.colorBalance.temperatureLabel} white balance · ${s.glare.hotspotPct}% glare.`;
  }

  private recommend(findings: FrameFinding[]): string {
    const issue = findings.find((f) => f.severity === 'issue');
    if (issue) return `${issue.label}: ${issue.detail}`;
    const warn = findings.find((f) => f.severity === 'warn');
    if (warn) return `${warn.label}: ${warn.detail}`;
    return 'Optical signal quality is good; no capture action needed.';
  }
}
