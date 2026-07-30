/**
 * Barcode / QR scanning via the browser-native `BarcodeDetector` API. This is a real, verifiable local decode:
 * it returns the decoded string and bounding box, never the image. `BarcodeDetector` ships in Chromium / Android
 * WebView but not everywhere, so the scanner feature-detects it and honestly reports `supported: false` rather
 * than pretending. Tests inject a `CodeScanner` fake, so the seam is exercised without a browser and no library
 * is bundled.
 */

import type { EdgeFrame } from './frame-analyzer.js';
import type {
  CodeObservation,
  DetectedCode,
  LocalObserver,
  ObserverContext
} from './local-observers.js';

export interface CodeScanResult {
  supported: boolean;
  codes: DetectedCode[];
}

export interface CodeScanner {
  readonly id: string;
  scan(frame: EdgeFrame): Promise<CodeScanResult>;
}

interface BarcodeDetectorLike {
  detect(source: unknown): Promise<
    Array<{ rawValue: string; format: string; boundingBox?: { x: number; y: number; width: number; height: number } }>
  >;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

type ImageDataCtor = new (data: Uint8ClampedArray, width: number, height: number) => unknown;

function getBarcodeDetectorCtor(): BarcodeDetectorCtor | undefined {
  const ctor = (globalThis as Record<string, unknown>).BarcodeDetector;
  return typeof ctor === 'function' ? (ctor as BarcodeDetectorCtor) : undefined;
}

function getImageDataCtor(): ImageDataCtor | undefined {
  const ctor = (globalThis as Record<string, unknown>).ImageData;
  return typeof ctor === 'function' ? (ctor as ImageDataCtor) : undefined;
}

function toClamped(data: EdgeFrame['data']): Uint8ClampedArray {
  if (data instanceof Uint8ClampedArray) return data;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i];
  return out;
}

/** Default browser scanner backed by `BarcodeDetector`; reports `supported: false` when the API is absent. */
export class BrowserBarcodeScanner implements CodeScanner {
  readonly id = 'barcode-detector-v1';
  private readonly formats?: string[];

  constructor(options: { formats?: string[] } = {}) {
    this.formats = options.formats;
  }

  async scan(frame: EdgeFrame): Promise<CodeScanResult> {
    const DetectorCtor = getBarcodeDetectorCtor();
    const ImageDataConstructor = getImageDataCtor();
    if (!DetectorCtor || !ImageDataConstructor) {
      return { supported: false, codes: [] };
    }
    try {
      const imageData = new ImageDataConstructor(toClamped(frame.data), frame.width, frame.height);
      const detector = new DetectorCtor(this.formats ? { formats: this.formats } : undefined);
      const detected = await detector.detect(imageData);
      const codes: DetectedCode[] = detected.map((d) => ({
        format: d.format,
        value: d.rawValue,
        box: d.boundingBox
          ? { x: d.boundingBox.x, y: d.boundingBox.y, width: d.boundingBox.width, height: d.boundingBox.height }
          : undefined
      }));
      return { supported: true, codes };
    } catch {
      return { supported: true, codes: [] };
    }
  }
}

function summarizeCodes(result: CodeScanResult): string {
  if (!result.supported) return 'Barcode/QR scanning is not available on this device.';
  if (result.codes.length === 0) return 'No barcode or QR code found in the frame.';
  const preview = result.codes
    .slice(0, 3)
    .map((c) => `${c.format}:${c.value.length > 32 ? `${c.value.slice(0, 32)}…` : c.value}`)
    .join(', ');
  return `${result.codes.length} code${result.codes.length === 1 ? '' : 's'} decoded (${preview}).`;
}

/** Wrap a `CodeScanner` as a `LocalObserver` so it composes with the capture provider's observer list. */
export function createCodeObserver(scanner: CodeScanner): LocalObserver {
  return {
    id: scanner.id,
    kind: 'code',
    async observe(frame: EdgeFrame, _context: ObserverContext): Promise<CodeObservation> {
      void _context;
      const result = await scanner.scan(frame);
      return {
        kind: 'code',
        detector: scanner.id,
        supported: result.supported,
        codes: result.codes,
        summary: summarizeCodes(result)
      };
    }
  };
}
