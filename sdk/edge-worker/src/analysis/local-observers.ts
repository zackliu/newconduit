/**
 * The local-observation seam. An observer runs inside the capture provider — where the raw frame legitimately
 * exists — and turns the frame into a small, verifiable, image-free structured observation (a decoded QR code,
 * a lit LED and its colour, a read meter digit, ...). Observations are additive to the optical `FrameAnalysis`
 * and, like it, never carry pixels. Heavy semantic understanding ("what device is this, is this wiring correct")
 * is deliberately NOT done here; that is the cloud multimodal agent's job. This keeps the phone honest: it only
 * emits things it can actually compute and verify on-device.
 */

import type { EdgeFrame } from './frame-analyzer.js';
import type { PixelRect } from './frame-processing.js';

export interface LedIndicator {
  color: 'red' | 'amber' | 'green' | 'blue' | 'white' | 'unknown';
  /** Detected blobs are lit; an absent indicator is reported by omission, not as `off`. */
  state: 'on';
  /** Fraction of the frame covered by this indicator blob, 0..100. */
  areaPct: number;
  /** Blob centroid in normalized frame coordinates, 0..1. */
  centroid: { x: number; y: number };
  meanRgb: [number, number, number];
}

export interface LedIndicatorObservation {
  kind: 'led-indicator';
  detector: string;
  indicators: LedIndicator[];
  summary: string;
}

export interface DetectedCode {
  format: string;
  value: string;
  box?: PixelRect;
}

export interface CodeObservation {
  kind: 'code';
  detector: string;
  supported: boolean;
  codes: DetectedCode[];
  summary: string;
}

export type DeviceObservation = LedIndicatorObservation | CodeObservation;

export interface ObserverContext {
  /** ISO timestamp of the capture the observation is derived from. */
  capturedAt: string;
}

/**
 * A local observer. `kind` is the capability string advertised in the device manifest so the console can honestly
 * describe what the phone can compute. `observe` returns `undefined` when it finds nothing to report.
 */
export interface LocalObserver {
  readonly id: string;
  readonly kind: string;
  observe(
    frame: EdgeFrame,
    context: ObserverContext
  ): Promise<DeviceObservation | undefined> | DeviceObservation | undefined;
}
