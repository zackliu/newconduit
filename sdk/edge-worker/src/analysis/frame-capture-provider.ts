import type {
  CaptureContext,
  CaptureFailureStatus,
  CaptureProvider,
  CaptureRequest,
  CaptureSource
} from './camera-diagnostic-agent.js';
import type { EdgeFrame, FrameAnalyzer } from './frame-analyzer.js';
import type { DeviceObservation, LocalObserver } from './local-observers.js';
import { maybeShareImage, type ImageSharingConfig, type LocalImageShareAuthorization } from './image-sharing.js';

/**
 * Bridges a device-specific frame source (browser camera, sample image, simulated buffer) into a
 * `CaptureProvider`. It is the single place that turns a raw `EdgeFrame` into structured `FrameAnalysis`,
 * runs any local observers (LED, barcode/QR) against the same frame, and applies the consent gate for
 * optional image sharing. By construction the raw frame is never returned — the privacy boundary is enforced
 * here rather than trusted to each caller — and an image only escapes through the explicit consent gate.
 */

export interface CapturedFrame {
  frame: EdgeFrame;
  source: CaptureSource;
  sampleSource: 'camera' | 'sample-image' | 'simulated';
  facingMode?: string;
  /** Local, per-capture approval. A remote `request.share` can request processing but cannot populate this. */
  imageShareAuthorization?: LocalImageShareAuthorization;
}

export type FrameProviderResult =
  | { status: 'captured'; captured: CapturedFrame }
  | { status: CaptureFailureStatus; reason: string };

export type FrameProvider = (request: CaptureRequest, context: CaptureContext) => Promise<FrameProviderResult>;

export interface EdgeCaptureProviderOptions {
  /** Local observers run against the frame in-place; filtered by `request.detect` (by `kind`) when present. */
  observers?: LocalObserver[];
  /** Consent gate configuration; defaults to no sharing when omitted. */
  imageSharing?: ImageSharingConfig;
}

async function runObservers(
  observers: LocalObserver[],
  request: CaptureRequest,
  frame: EdgeFrame,
  capturedAt: string
): Promise<DeviceObservation[] | undefined> {
  const wanted = request.detect;
  const selected = wanted && wanted.length > 0 ? observers.filter((o) => wanted.includes(o.kind)) : observers;
  if (selected.length === 0) return undefined;
  const observations: DeviceObservation[] = [];
  for (const observer of selected) {
    const observation = await observer.observe(frame, { capturedAt });
    if (observation) observations.push(observation);
  }
  return observations.length > 0 ? observations : undefined;
}

export function createAnalyzerCaptureProvider(
  analyzer: FrameAnalyzer,
  provider: FrameProvider,
  options: EdgeCaptureProviderOptions = {}
): CaptureProvider {
  const observers = options.observers ?? [];
  return {
    async capture(request, context) {
      const result = await provider(request, context);
      if (result.status !== 'captured') {
        return { status: result.status, reason: result.reason };
      }
      const { frame, source, sampleSource, facingMode, imageShareAuthorization } = result.captured;
      const capturedAt = new Date().toISOString();
      const analysis = analyzer.analyze(frame, { capturedAt });
      const observations = await runObservers(observers, request, frame, capturedAt);
      const sharedImage = await maybeShareImage(frame, request.share, imageShareAuthorization, options.imageSharing);
      return {
        status: 'captured',
        source,
        analysis,
        observations,
        sharedImage,
        media: { width: frame.width, height: frame.height, facingMode, sampleSource }
      };
    }
  };
}
