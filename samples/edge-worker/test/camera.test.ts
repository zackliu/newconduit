import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserCamera } from '../src/camera.js';

test('camera: a getUserMedia stream that resolves after cancellation is stopped and never activated', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let resolveStream!: (stream: MediaStream) => void;
  let stopped = 0;
  const video = {
    playsInline: false,
    muted: false,
    autoplay: false,
    srcObject: null as MediaStream | null,
    videoWidth: 1,
    videoHeight: 1,
    setAttribute: () => undefined,
    play: async () => undefined
  };
  const stream = {
    getTracks: () => [{ stop: () => { stopped++; } }]
  } as unknown as MediaStream;

  try {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: (tag: string) => tag === 'video' ? video : {} }
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: () => new Promise<MediaStream>((resolve) => { resolveStream = resolve; })
        }
      }
    });

    const camera = new BrowserCamera();
    const abort = new AbortController();
    const opening = camera.open('environment', abort.signal);
    abort.abort();
    resolveStream(stream);

    await assert.rejects(opening, /cancelled/);
    assert.equal(stopped, 1);
    assert.equal(camera.isLive, false);
    assert.equal(video.srcObject, null);
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
