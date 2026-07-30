import type {
  CaptureSource,
  EdgeDeviceManifest,
  EdgeFrame
} from '@agent-runtime-sidecar/edge-worker';

/**
 * Browser-specific capture glue. This is the ONLY place that touches a real sensor: it turns a live
 * `getUserMedia` stream (or a locally generated sample frame) into an `EdgeFrame` RGBA buffer. The buffer
 * is handed to the SDK analyzer and then discarded — it never leaves this module, which is what keeps the
 * privacy contract ("raw media stays on device") honest.
 */

export function hasCameraSupport(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
}

export function isSecureBrowserContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true;
}

export function cameraAvailability(): { camera: boolean; secure: boolean; usable: boolean; reason?: string } {
  const camera = hasCameraSupport();
  const secure = isSecureBrowserContext();
  if (!camera) return { camera, secure, usable: false, reason: 'This browser does not expose a camera (getUserMedia).' };
  if (!secure) return { camera, secure, usable: false, reason: 'Camera needs a secure context (https or localhost). Use the sample-frame fallback or an https tunnel.' };
  return { camera, secure, usable: true };
}

export function hasBarcodeDetector(): boolean {
  return typeof (globalThis as Record<string, unknown>).BarcodeDetector === 'function';
}

export function buildManifest(deviceLabel: string): EdgeDeviceManifest {
  const { camera, secure, usable } = cameraAvailability();
  const captureSources: CaptureSource[] = usable ? ['environment', 'user'] : [];
  const barcode = hasBarcodeDetector();
  const detectors: NonNullable<EdgeDeviceManifest['detectors']> = [
    { id: 'led-indicator-v1', kind: 'led-indicator', displayName: 'LED indicator colour/area' }
  ];
  if (barcode) {
    detectors.push({ id: 'barcode-detector-v1', kind: 'code', displayName: 'Barcode / QR (native BarcodeDetector)' });
  }
  const notes: string[] = [];
  if (!camera) notes.push('No camera API in this browser; only sample-frame diagnostics are available.');
  if (camera && !secure) notes.push('Insecure context: the live camera is blocked; sample-frame fallback still analyses locally.');
  if (!barcode) notes.push('This browser has no native BarcodeDetector; barcode/QR reads degrade to manual entry — codes are never faked.');
  notes.push('This worker is a browser tab, not a daemon. Closing or backgrounding the page suspends the worker.');
  return {
    deviceLabel,
    runtime: `Browser edge worker · ${navigator.userAgent.split(') ')[0]})`,
    captureSources,
    analyzers: [{ id: 'canvas-heuristic-v1', displayName: 'Canvas heuristic analyzer' }],
    detectors,
    secureContext: secure,
    privacy: { rawMediaLeavesDevice: false, returns: 'structured-analysis-only' },
    notes
  };
}

function facingFor(source: CaptureSource): 'environment' | 'user' {
  return source === 'user' ? 'user' : 'environment';
}

export class BrowserCamera {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private activeFacing: 'environment' | 'user' | undefined;
  private generation = 0;

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.setAttribute('playsinline', '');
  }

  get isLive(): boolean {
    return !!this.stream;
  }

  get facing(): 'environment' | 'user' | undefined {
    return this.activeFacing;
  }

  /** Opens the camera. MUST be called from a user gesture; throws NotAllowedError if the user denies. */
  async open(source: CaptureSource, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Camera request was cancelled.');
    const facingMode = facingFor(source);
    if (this.stream && this.activeFacing === facingMode) return;
    this.stop();
    const generation = ++this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    if (signal?.aborted || generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Camera request was cancelled.');
    }
    this.stream = stream;
    this.activeFacing = facingMode;
    this.video.srcObject = stream;
    await this.video.play().catch(() => undefined);
    await this.waitForFrame(signal, generation);
    if (signal?.aborted || generation !== this.generation) {
      this.stop();
      throw new Error('Camera request was cancelled.');
    }
  }

  private async waitForFrame(signal: AbortSignal | undefined, generation: number): Promise<void> {
    const deadline = Date.now() + 4000;
    while (this.video.videoWidth === 0 && Date.now() < deadline && !signal?.aborted && generation === this.generation) {
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  /** Grabs the current camera frame as an EdgeFrame. Returns undefined if no frame is ready yet. */
  grabFrame(): EdgeFrame | undefined {
    if (!this.stream || this.video.videoWidth === 0) return undefined;
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    const ctx = this.context(width, height);
    if (!ctx) return undefined;
    ctx.drawImage(this.video, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    return { data: image.data, width, height };
  }

  stop(): void {
    this.generation++;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.activeFacing = undefined;
    this.video.srcObject = null;
  }

  private context(width: number, height: number): CanvasRenderingContext2D | null {
    if (!this.canvas) this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    return this.canvas.getContext('2d', { willReadFrequently: true });
  }
}

/**
 * Generates a synthetic-but-realistic frame for the no-camera / insecure-context / desktop path. It is a
 * genuine RGBA buffer, so the analyzer computes real signals (brightness, cast, glare, sharpness) rather
 * than a hard-coded result. Each call varies so repeated captures look like distinct measurements.
 */
export function sampleFrame(source: CaptureSource): EdgeFrame {
  const width = 640;
  const height = 480;
  const data = new Uint8ClampedArray(width * height * 4);
  const seed = Date.now();
  const warm = source === 'user' ? 1.12 : 0.94;
  const baseBrightness = 70 + ((seed >> 4) % 90);
  const glareX = width * (0.35 + ((seed >> 7) % 40) / 100);
  const glareY = height * (0.3 + ((seed >> 5) % 40) / 100);
  const glareRadius = 70 + ((seed >> 3) % 60);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const vignette = 1 - 0.35 * (Math.hypot(x - width / 2, y - height / 2) / (width / 2));
      const gradient = baseBrightness * vignette + (x / width) * 40;
      const noise = ((x * 13 + y * 7 + seed) % 17) - 8;
      const dist = Math.hypot(x - glareX, y - glareY);
      const glare = dist < glareRadius ? (1 - dist / glareRadius) * 150 : 0;
      const luma = gradient + noise + glare;
      data[i] = clampByte(luma * warm);
      data[i + 1] = clampByte(luma);
      data[i + 2] = clampByte(luma / warm);
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

function clampByte(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value;
}
