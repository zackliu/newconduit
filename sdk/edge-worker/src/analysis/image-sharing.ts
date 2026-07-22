/**
 * The consent gate for sharing an actual image off the device. By default the phone returns structured results
 * only and no pixels ever leave. An image is produced ONLY when all of these hold: the manifest policy is
 * `on-explicit-consent`, the specific capture request carries `consent: true`, and an `ImageEncoder` is wired in.
 * Even then the frame is first cropped to the relevant region, sensitive rectangles are masked, and it is
 * downscaled before encoding. There is deliberately no default encoder, so the "share" path cannot fire by
 * accident. This makes "raw/cropped image only with explicit consent" a real, testable mechanism, not a promise.
 */

import type { EdgeFrame } from './frame-analyzer';
import { cropFrame, downscaleFrame, maskRegions, type PixelRect } from './frame-processing';

export interface ImageEncoder {
  readonly mimeType: string;
  encode(frame: EdgeFrame): Promise<{ dataUrl: string; bytes: number }>;
}

export interface ShareRequest {
  /** Must be explicitly true; anything else keeps the frame on-device. */
  consent: boolean;
  /** Human-readable scope the user consented to (e.g. "router label crop"). */
  scope?: string;
  crop?: PixelRect;
  mask?: PixelRect[];
  maskMode?: 'blackout' | 'pixelate';
  maxEdge?: number;
}

export type ImageSharingPolicy = 'off' | 'on-explicit-consent';

export interface ImageSharingConfig {
  policy: ImageSharingPolicy;
  encoder?: ImageEncoder;
  /** Applied when the request omits `maxEdge`. Default 1024. */
  defaultMaxEdge?: number;
}

export interface SharedImageArtifact {
  encoding: string;
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  processing: { cropped: boolean; downscaled: boolean; maskedRegions: number };
  consent: { consented: true; scope: string; grantedAt: string };
}

/**
 * Returns a processed, consented image artifact, or `undefined` when sharing is not permitted for this capture.
 * The default (policy `off`, no consent, or no encoder) always returns `undefined`.
 */
export async function maybeShareImage(
  frame: EdgeFrame,
  request: ShareRequest | undefined,
  config: ImageSharingConfig | undefined,
  now: () => string = () => new Date().toISOString()
): Promise<SharedImageArtifact | undefined> {
  if (!config || config.policy !== 'on-explicit-consent') return undefined;
  if (!request || request.consent !== true) return undefined;
  if (!config.encoder) return undefined;

  let processed = frame;
  let cropped = false;
  let maskedRegions = 0;

  if (request.crop) {
    processed = cropFrame(processed, request.crop);
    cropped = true;
  }
  if (request.mask && request.mask.length > 0) {
    processed = maskRegions(processed, request.mask, { mode: request.maskMode ?? 'blackout' });
    maskedRegions = request.mask.length;
  }

  const maxEdge = request.maxEdge ?? config.defaultMaxEdge ?? 1024;
  const beforeW = processed.width;
  const beforeH = processed.height;
  processed = downscaleFrame(processed, maxEdge);
  const downscaled = processed.width !== beforeW || processed.height !== beforeH;

  const encoded = await config.encoder.encode(processed);
  return {
    encoding: config.encoder.mimeType,
    dataUrl: encoded.dataUrl,
    width: processed.width,
    height: processed.height,
    bytes: encoded.bytes,
    processing: { cropped, downscaled, maskedRegions },
    consent: { consented: true, scope: request.scope ?? 'device-view', grantedAt: now() }
  };
}

interface CanvasLike {
  getContext(type: '2d'): {
    putImageData(imageData: unknown, dx: number, dy: number): void;
  } | null;
  toDataURL(type?: string, quality?: number): string;
}

function base64Bytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/**
 * Canvas-based JPEG/PNG encoder for the browser. Requires a DOM/OffscreenCanvas and `ImageData`; throws at
 * encode time when neither is available, so it never silently degrades to shipping something unexpected.
 */
export function createBrowserImageEncoder(options: { mimeType?: string; quality?: number } = {}): ImageEncoder {
  const mimeType = options.mimeType ?? 'image/jpeg';
  const quality = options.quality ?? 0.82;
  return {
    mimeType,
    async encode(frame: EdgeFrame): Promise<{ dataUrl: string; bytes: number }> {
      const globals = globalThis as Record<string, unknown>;
      const ImageDataConstructor = globals.ImageData as
        | (new (data: Uint8ClampedArray, w: number, h: number) => unknown)
        | undefined;
      if (!ImageDataConstructor) {
        throw new Error('createBrowserImageEncoder requires a browser ImageData constructor');
      }
      const clamped =
        frame.data instanceof Uint8ClampedArray ? frame.data : Uint8ClampedArray.from(frame.data as ArrayLike<number>);
      const imageData = new ImageDataConstructor(clamped, frame.width, frame.height);

      let canvas: CanvasLike | undefined;
      const OffscreenCanvasCtor = globals.OffscreenCanvas as
        | (new (w: number, h: number) => CanvasLike)
        | undefined;
      if (OffscreenCanvasCtor) {
        canvas = new OffscreenCanvasCtor(frame.width, frame.height);
      } else {
        const doc = globals.document as { createElement(tag: string): CanvasLike } | undefined;
        if (doc) {
          canvas = doc.createElement('canvas');
          (canvas as unknown as { width: number; height: number }).width = frame.width;
          (canvas as unknown as { width: number; height: number }).height = frame.height;
        }
      }
      if (!canvas) {
        throw new Error('createBrowserImageEncoder requires a canvas (OffscreenCanvas or document.createElement)');
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('createBrowserImageEncoder could not obtain a 2d canvas context');
      }
      ctx.putImageData(imageData, 0, 0);
      const dataUrl = canvas.toDataURL(mimeType, quality);
      return { dataUrl, bytes: base64Bytes(dataUrl) };
    }
  };
}
