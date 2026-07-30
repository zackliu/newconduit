import type { EdgeAgent, EdgeAgentContext, EdgeTurnInput, EdgeTurnResult } from '../edge-agent.js';
import { CanvasHeuristicAnalyzer, type FrameAnalysis, type FrameAnalyzer } from './frame-analyzer.js';
import type { CodeObservation, DeviceObservation, LedIndicatorObservation } from './local-observers.js';
import type { ImageSharingPolicy, ShareRequest, SharedImageArtifact } from './image-sharing.js';

/**
 * The camera diagnostic agent turns a routed cloud-session task into a bounded, local device-capture
 * measurement. It never touches a sensor itself: capture is delegated to a `CaptureProvider` that must be
 * driven by an explicit user action, and the provider returns only structured `FrameAnalysis` plus optional
 * local observations (LED, barcode/QR) — the raw frame stays on the device by contract. An actual image is
 * only ever attached when the local capture provider records explicit per-capture authorization and is
 * configured to honour it; remote task data can request a scope but cannot grant consent.
 */

export type CaptureSource = 'environment' | 'user';

export interface CaptureRequest {
  captureId: string;
  source: CaptureSource;
  target: string;
  reason?: string;
  /** Observer kinds to run (e.g. `['led-indicator','code']`). Omitted runs all configured observers. */
  detect?: string[];
  /** Optional image-processing request. The device holder must authorize sharing separately and locally. */
  share?: ShareRequest;
}

export interface CaptureContext {
  progress(text: string): Promise<void> | void;
  delta(text: string): Promise<void> | void;
  readonly signal: AbortSignal;
}

export interface CaptureMediaMeta {
  width: number;
  height: number;
  facingMode?: string;
  sampleSource: 'camera' | 'sample-image' | 'simulated';
}

export type CaptureFailureStatus = 'declined' | 'unavailable' | 'no_camera' | 'insecure_context' | 'aborted';

export type CaptureOutcome =
  | {
      status: 'captured';
      source: CaptureSource;
      analysis: FrameAnalysis;
      media: CaptureMediaMeta;
      observations?: DeviceObservation[];
      sharedImage?: SharedImageArtifact;
    }
  | { status: CaptureFailureStatus; reason: string };

export interface CaptureProvider {
  capture(request: CaptureRequest, context: CaptureContext): Promise<CaptureOutcome>;
}

export interface EdgeDeviceManifest {
  deviceLabel: string;
  runtime: string;
  captureSources: CaptureSource[];
  analyzers: { id: string; displayName: string }[];
  /** Local observers the device can run beyond optical analysis (LED indicators, barcode/QR, ...). */
  detectors?: { id: string; kind: string; displayName: string }[];
  secureContext: boolean;
  privacy: {
    rawMediaLeavesDevice: false;
    returns: 'structured-analysis-only';
  };
  /** How the device treats sharing an actual image. Defaults to off (structured-only) when omitted. */
  imageSharing?: {
    policy: ImageSharingPolicy;
    scopes?: string[];
  };
  notes?: string[];
}

export interface CameraDiagnosticAgentOptions {
  captureProvider: CaptureProvider;
  manifestProvider: () => EdgeDeviceManifest;
  analyzer?: FrameAnalyzer;
}

interface ParsedTask {
  task: 'manifest' | 'capture';
  captureId: string;
  source: CaptureSource;
  target: string;
  reason?: string;
  detect?: string[];
  share?: ShareRequest;
}

export class CameraDiagnosticAgent implements EdgeAgent {
  private readonly captureProvider: CaptureProvider;
  private readonly manifestProvider: () => EdgeDeviceManifest;
  private readonly analyzer: FrameAnalyzer;
  private captureCounter = 0;

  constructor(options: CameraDiagnosticAgentOptions) {
    this.captureProvider = options.captureProvider;
    this.manifestProvider = options.manifestProvider;
    this.analyzer = options.analyzer ?? new CanvasHeuristicAnalyzer();
  }

  async runTurn(input: EdgeTurnInput, context: EdgeAgentContext): Promise<EdgeTurnResult> {
    const parsed = this.parseTask(input);

    if (parsed.task === 'manifest') {
      const manifest = this.manifestProvider();
      await context.progress('Reporting device capability manifest');
      return {
        message: `Edge device ready: ${manifest.deviceLabel}. Capture sources: ${manifest.captureSources.join(', ') || 'none available'}. Raw media never leaves the device.`,
        output: { kind: 'device-manifest', manifest }
      };
    }

    const manifest = this.manifestProvider();
    if (!manifest.captureSources.includes(parsed.source)) {
      await context.progress(`Requested capture source "${parsed.source}" is out of scope for this device`);
      return this.failureResult(parsed, 'unavailable', `Capture source "${parsed.source}" is not offered by this device's capability manifest.`);
    }

    await context.progress(`Task received: capture ${parsed.target} via ${parsed.source} camera (awaiting explicit device authorization)`);

    let outcome: CaptureOutcome;
    try {
      outcome = await this.captureProvider.capture(
        {
          captureId: parsed.captureId,
          source: parsed.source,
          target: parsed.target,
          reason: parsed.reason,
          detect: parsed.detect,
          share: parsed.share
        },
        context
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return this.failureResult(parsed, 'unavailable', `Capture failed: ${reason}`);
    }

    if (outcome.status !== 'captured') {
      await context.progress(`Capture not completed: ${outcome.status}`);
      return this.failureResult(parsed, outcome.status, outcome.reason);
    }

    await context.progress(`Analyzed frame locally with ${this.analyzer.displayName}`);
    if (outcome.observations && outcome.observations.length > 0) {
      await context.progress(`Local observers reported ${outcome.observations.length} observation(s)`);
    }
    if (outcome.sharedImage) {
      await context.progress(`Attached a consented, processed image (${outcome.sharedImage.bytes} bytes)`);
    }
    return {
      message: this.buildCaptureMessage(parsed, outcome),
      output: {
        kind: 'device-evidence',
        captureId: parsed.captureId,
        status: 'captured',
        source: outcome.source,
        target: parsed.target,
        media: outcome.media,
        analysis: outcome.analysis,
        observations: outcome.observations ?? [],
        imageShared: Boolean(outcome.sharedImage),
        ...(outcome.sharedImage ? { sharedImage: outcome.sharedImage } : {}),
        privacy: outcome.sharedImage ? 'processed-image-shared-with-consent' : 'raw-frame-retained-on-device'
      }
    };
  }

  /**
   * Build the turn `message`. This is the ONLY field the delegation runtime forwards back to the parent
   * cloud agent (the structured `output` is persisted on the child session but not returned as the tool
   * result), so it must carry both a human summary and a compact, machine-parseable structured observation.
   * It still contains no pixels — only bounded optical signals, detected indicators, and decoded codes, with
   * honest detector-availability flags.
   */
  private buildCaptureMessage(
    parsed: ParsedTask,
    outcome: Extract<CaptureOutcome, { status: 'captured' }>
  ): string {
    const observations = outcome.observations ?? [];
    const led = observations.find((o): o is LedIndicatorObservation => o.kind === 'led-indicator');
    const code = observations.find((o): o is CodeObservation => o.kind === 'code');
    const signals = outcome.analysis.signals;
    const structured = {
      status: 'captured' as const,
      target: parsed.target,
      source: outcome.source,
      quality: outcome.analysis.qualityScore,
      signals: {
        brightness: signals.brightness.normalized,
        highlightsClippedPct: signals.exposure.clippedHighlightsPct,
        shadowsClippedPct: signals.exposure.clippedShadowsPct,
        contrast: signals.contrast.normalized,
        focus: signals.sharpness.focusScore,
        glarePct: signals.glare.brightPixelPct,
        colorCast: signals.colorBalance.dominantCast,
        temperature: signals.colorBalance.temperatureLabel,
        estimatedKelvin: signals.colorBalance.estimatedKelvin
      },
      findings: outcome.analysis.findings.slice(0, 8).map((f) => ({ code: f.code, severity: f.severity, label: f.label })),
      indicators: led ? led.indicators.slice(0, 8).map((i) => ({ color: i.color, areaPct: i.areaPct })) : [],
      codes: code && code.supported ? code.codes.slice(0, 8).map((c) => ({ format: c.format, value: c.value })) : [],
      detectors: {
        led: led ? 'ran' : 'not-run',
        code: code ? (code.supported ? 'ran' : 'unsupported') : 'not-run'
      },
      imageShared: Boolean(outcome.sharedImage),
      privacy: outcome.sharedImage ? 'processed-image-shared-with-consent' : 'raw-frame-retained-on-device'
    };
    return `${outcome.analysis.summary} ${outcome.analysis.recommendation}\nstructured-observation: ${JSON.stringify(structured)}`;
  }

  private failureResult(parsed: ParsedTask, status: CaptureFailureStatus | 'unavailable', reason: string): EdgeTurnResult {
    return {
      message: `Could not capture ${parsed.target}: ${reason}`,
      output: {
        kind: 'device-evidence',
        captureId: parsed.captureId,
        status,
        source: parsed.source,
        target: parsed.target,
        reason
      }
    };
  }

  private parseTask(input: EdgeTurnInput): ParsedTask {
    const fallbackId = `cap-${input.turnSeq}-${++this.captureCounter}`;
    const raw = input.message.trim();
    let record: Record<string, unknown> | undefined;
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          record = parsed as Record<string, unknown>;
        }
      } catch {
        record = undefined;
      }
    }

    const taskName = typeof record?.task === 'string' ? record.task : undefined;
    if (taskName === 'manifest') {
      return { task: 'manifest', captureId: fallbackId, source: 'environment', target: 'device' };
    }

    const source: CaptureSource = record?.source === 'user' ? 'user' : 'environment';
    const target = typeof record?.target === 'string' && record.target.length > 0 ? record.target : 'scene';
    const reason = typeof record?.reason === 'string'
      ? record.reason
      : record
        ? undefined
        : raw.length > 0
          ? raw
          : undefined;
    const captureId = typeof record?.captureId === 'string' && record.captureId.length > 0 ? record.captureId : fallbackId;
    const detect = Array.isArray(record?.detect)
      ? (record!.detect as unknown[]).filter((v): v is string => typeof v === 'string')
      : undefined;
    const share = this.parseShare(record?.share);
    return { task: 'capture', captureId, source, target, reason, detect, share };
  }

  private parseShare(value: unknown): ShareRequest | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const share: ShareRequest = {};
    if (typeof record.scope === 'string') share.scope = record.scope;
    if (typeof record.maxEdge === 'number') share.maxEdge = record.maxEdge;
    if (record.maskMode === 'blackout' || record.maskMode === 'pixelate') share.maskMode = record.maskMode;
    const crop = this.parseRect(record.crop);
    if (crop) share.crop = crop;
    if (Array.isArray(record.mask)) {
      const mask = record.mask.map((r) => this.parseRect(r)).filter((r): r is NonNullable<typeof r> => Boolean(r));
      if (mask.length > 0) share.mask = mask;
    }
    return share;
  }

  private parseRect(value: unknown): { x: number; y: number; width: number; height: number } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const r = value as Record<string, unknown>;
    if (
      typeof r.x === 'number' &&
      typeof r.y === 'number' &&
      typeof r.width === 'number' &&
      typeof r.height === 'number'
    ) {
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return undefined;
  }
}
