export { EDGE_WORKER_HTTP_PATHS, EDGE_WORKER_HTTP_QUERY } from './protocol';
export type {
  EdgeRuntimeChannel,
  EdgeRuntimeActor,
  EdgeRuntimeEvent,
  WorkerRegisterPayload,
  EdgeBindingPayload,
  PairingRedeemRequest,
  PairingRedeemResult,
  WorkerCondition,
  WorkerRecord,
  RuntimeConnectionGrant,
  WorkerHeartbeatPayload,
  WorkerHeartbeatRejectedPayload,
  AssignedAgentSpec,
  SessionAssignPayload,
  SessionInputCommandPayload,
  SessionPauseCommandPayload,
  AgentOutputPayload,
  TurnCompletedPayload,
  TurnFailedPayload,
  StatusChangedPayload,
  SessionPausedPayload,
  WorkerCommandAcceptedPayload,
  WorkerCommandRejectedPayload
} from './protocol';

export { EdgeWorkerChannelMapper } from './worker-channel-map';

export { redeemPairingInvite } from './pairing';
export type { RedeemPairingInviteInput } from './pairing';

export { WebPubSubEdgeWorkerTransport } from './transport';
export type {
  EdgeWorkerTransport,
  EdgeWorkerSubscription,
  EdgeRuntimeEventHandler,
  WebPubSubEdgeWorkerTransportOptions,
  EdgeTransportConnectionState,
  EdgeTransportConnectionListener
} from './transport';

export {
  InMemoryOutboundQueueStore,
  LocalStorageOutboundQueueStore,
  newQueuedResult
} from './outbound-queue';
export type { OutboundQueueStore, QueuedResult, WebStorageLike } from './outbound-queue';

export type { EdgeAgent, EdgeAgentContext, EdgeTurnInput, EdgeTurnResult } from './edge-agent';

export { EdgeWorkerRuntime } from './edge-worker-runtime';
export type {
  EdgeWorkerRegistration,
  EdgeWorkerRuntimeOptions,
  EdgeWorkerLifecycleEvent,
  EdgeWorkerObserver
} from './edge-worker-runtime';

export { CanvasHeuristicAnalyzer } from './analysis/frame-analyzer';
export type {
  EdgeFrame,
  FrameAnalyzer,
  FrameAnalysis,
  FrameAnalyzeOptions,
  FrameSignals,
  FrameFinding,
  SignalSeverity
} from './analysis/frame-analyzer';

export { CameraDiagnosticAgent } from './analysis/camera-diagnostic-agent';
export type {
  CameraDiagnosticAgentOptions,
  CaptureProvider,
  CaptureContext,
  CaptureRequest,
  CaptureOutcome,
  CaptureMediaMeta,
  CaptureSource,
  CaptureFailureStatus,
  EdgeDeviceManifest
} from './analysis/camera-diagnostic-agent';

export { createAnalyzerCaptureProvider } from './analysis/frame-capture-provider';
export type {
  CapturedFrame,
  FrameProvider,
  FrameProviderResult,
  EdgeCaptureProviderOptions
} from './analysis/frame-capture-provider';

export { cropFrame, downscaleFrame, maskRegions, clampRect } from './analysis/frame-processing';
export type { PixelRect, MaskOptions } from './analysis/frame-processing';

export type {
  LocalObserver,
  ObserverContext,
  DeviceObservation,
  LedIndicator,
  LedIndicatorObservation,
  CodeObservation,
  DetectedCode
} from './analysis/local-observers';

export { LedIndicatorAnalyzer, LedBlinkTracker } from './analysis/led-indicator-analyzer';
export type { LedIndicatorOptions, BlinkState } from './analysis/led-indicator-analyzer';

export { BrowserBarcodeScanner, createCodeObserver } from './analysis/code-scanner';
export type { CodeScanner, CodeScanResult } from './analysis/code-scanner';

export { maybeShareImage, createBrowserImageEncoder } from './analysis/image-sharing';
export type {
  ImageEncoder,
  ShareRequest,
  ImageSharingPolicy,
  ImageSharingConfig,
  SharedImageArtifact
} from './analysis/image-sharing';
