/**
 * Pure, deterministic frame processing for the browser edge worker. These operations run entirely on the
 * device against raw RGBA pixels and never touch the network. They implement the phone-side responsibilities
 * of the honest hybrid design — crop, downscale/compress input, and privacy masking — so that if a frame is
 * ever shared with explicit consent it can first be reduced to the smallest relevant region with sensitive
 * areas redacted. Nothing here decides *whether* to share; that gate lives in `image-sharing.ts`.
 */

import type { EdgeFrame } from './frame-analyzer';

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MaskOptions {
  /** `blackout` replaces the region with a solid colour; `pixelate` averages fixed blocks. Default `blackout`. */
  mode?: 'blackout' | 'pixelate';
  /** Block edge (pixels) for `pixelate`. Minimum 2. Default 12. */
  blockSize?: number;
  /** Fill colour for `blackout`. Default black. */
  color?: [number, number, number];
}

function toInt(value: number): number {
  return Math.round(value);
}

/** Clamp a requested rectangle to the frame bounds, rounding to integer pixels. */
export function clampRect(rect: PixelRect, width: number, height: number): PixelRect {
  const x0 = Math.min(Math.max(0, toInt(rect.x)), width);
  const y0 = Math.min(Math.max(0, toInt(rect.y)), height);
  const x1 = Math.min(Math.max(x0, toInt(rect.x + rect.width)), width);
  const y1 = Math.min(Math.max(y0, toInt(rect.y + rect.height)), height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function copyFrame(frame: EdgeFrame): EdgeFrame {
  const data = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = frame.data[i];
  }
  return { data, width: frame.width, height: frame.height };
}

/** Crop the frame to `rect` (clamped to bounds). Throws if the clamped rectangle is empty. */
export function cropFrame(frame: EdgeFrame, rect: PixelRect): EdgeFrame {
  const r = clampRect(rect, frame.width, frame.height);
  if (r.width < 1 || r.height < 1) {
    throw new Error('crop rect is empty after clamping to frame bounds');
  }
  const out = new Uint8ClampedArray(r.width * r.height * 4);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const si = ((r.y + y) * frame.width + (r.x + x)) * 4;
      const di = (y * r.width + x) * 4;
      out[di] = frame.data[si];
      out[di + 1] = frame.data[si + 1];
      out[di + 2] = frame.data[si + 2];
      out[di + 3] = frame.data[si + 3];
    }
  }
  return { data: out, width: r.width, height: r.height };
}

/**
 * Downscale so the longest edge is at most `maxEdge`, using box averaging. Returns a copy unchanged when the
 * frame already fits. This is the input-size reduction step before optional encoding/upload.
 */
export function downscaleFrame(frame: EdgeFrame, maxEdge: number): EdgeFrame {
  if (!Number.isFinite(maxEdge) || maxEdge < 1) {
    throw new Error('maxEdge must be a positive number');
  }
  const { width, height } = frame;
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return copyFrame(frame);
  }
  const scale = maxEdge / longest;
  const tw = Math.max(1, Math.round(width * scale));
  const th = Math.max(1, Math.round(height * scale));
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor((ty * height) / th);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * height) / th));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor((tx * width) / tw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * width) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * width + sx) * 4;
          r += frame.data[i];
          g += frame.data[i + 1];
          b += frame.data[i + 2];
          a += frame.data[i + 3];
          n++;
        }
      }
      const o = (ty * tw + tx) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { data: out, width: tw, height: th };
}

function blackout(frame: EdgeFrame, r: PixelRect, color: [number, number, number]): void {
  for (let y = r.y; y < r.y + r.height; y++) {
    for (let x = r.x; x < r.x + r.width; x++) {
      const i = (y * frame.width + x) * 4;
      frame.data[i] = color[0];
      frame.data[i + 1] = color[1];
      frame.data[i + 2] = color[2];
    }
  }
}

function pixelate(frame: EdgeFrame, r: PixelRect, blockSize: number): void {
  for (let by = r.y; by < r.y + r.height; by += blockSize) {
    for (let bx = r.x; bx < r.x + r.width; bx += blockSize) {
      const ex = Math.min(bx + blockSize, r.x + r.width);
      const ey = Math.min(by + blockSize, r.y + r.height);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * frame.width + x) * 4;
          sr += frame.data[i];
          sg += frame.data[i + 1];
          sb += frame.data[i + 2];
          n++;
        }
      }
      if (n === 0) continue;
      const ar = sr / n;
      const ag = sg / n;
      const ab = sb / n;
      for (let y = by; y < ey; y++) {
        for (let x = bx; x < ex; x++) {
          const i = (y * frame.width + x) * 4;
          frame.data[i] = ar;
          frame.data[i + 1] = ag;
          frame.data[i + 2] = ab;
        }
      }
    }
  }
}

/**
 * Redact one or more rectangular regions (out-of-bounds parts are clamped, empty rects skipped). Returns a new
 * frame; the input is not mutated. Use this to remove serial numbers, labels, faces, or bystanders before any
 * consented image ever leaves the device.
 */
export function maskRegions(frame: EdgeFrame, rects: PixelRect[], options: MaskOptions = {}): EdgeFrame {
  const out = copyFrame(frame);
  const mode = options.mode ?? 'blackout';
  for (const raw of rects) {
    const r = clampRect(raw, frame.width, frame.height);
    if (r.width < 1 || r.height < 1) continue;
    if (mode === 'blackout') {
      blackout(out, r, options.color ?? [0, 0, 0]);
    } else {
      pixelate(out, r, Math.max(2, Math.floor(options.blockSize ?? 12)));
    }
  }
  return out;
}
