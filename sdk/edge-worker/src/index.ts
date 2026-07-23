export { EDGE_WORKER_HTTP_PATHS, EDGE_WORKER_HTTP_QUERY } from './protocol.js';
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
  WorkerResultAcknowledgedPayload,
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
} from './protocol.js';

export { EdgeWorkerChannelMapper } from './worker-channel-map.js';

export { redeemPairingInvite } from './pairing.js';
export type { RedeemPairingInviteInput } from './pairing.js';

export { WebPubSubEdgeWorkerTransport } from './transport.js';
export type {
  EdgeWorkerTransport,
  EdgeWorkerSubscription,
  EdgeRuntimeEventHandler,
  WebPubSubEdgeWorkerTransportOptions,
  EdgeTransportConnectionState,
  EdgeTransportConnectionListener
} from './transport.js';

export {
  InMemoryOutboundQueueStore,
  LocalStorageOutboundQueueStore,
  newQueuedResult
} from './outbound-queue.js';
export type { OutboundQueueStore, QueuedResult, WebStorageLike } from './outbound-queue.js';

export type { EdgeAgent, EdgeAgentContext, EdgeTurnInput, EdgeTurnResult } from './edge-agent.js';

export { EdgeWorkerRuntime } from './edge-worker-runtime.js';
export type {
  EdgeWorkerRegistration,
  EdgeWorkerRuntimeOptions,
  EdgeWorkerLifecycleEvent,
  EdgeWorkerObserver
} from './edge-worker-runtime.js';

export { CanvasHeuristicAnalyzer } from './analysis/frame-analyzer.js';
export type {
  EdgeFrame,
  FrameAnalyzer,
  FrameAnalysis,
  FrameAnalyzeOptions,
  FrameSignals,
  FrameFinding,
  SignalSeverity
} from './analysis/frame-analyzer.js';

export { CameraDiagnosticAgent } from './analysis/camera-diagnostic-agent.js';
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
} from './analysis/camera-diagnostic-agent.js';

export { createAnalyzerCaptureProvider } from './analysis/frame-capture-provider.js';
export type {
  CapturedFrame,
  FrameProvider,
  FrameProviderResult,
  EdgeCaptureProviderOptions
} from './analysis/frame-capture-provider.js';

export { cropFrame, downscaleFrame, maskRegions, clampRect } from './analysis/frame-processing.js';
export type { PixelRect, MaskOptions } from './analysis/frame-processing.js';

export type {
  LocalObserver,
  ObserverContext,
  DeviceObservation,
  LedIndicator,
  LedIndicatorObservation,
  CodeObservation,
  DetectedCode
} from './analysis/local-observers.js';

export { LedIndicatorAnalyzer, LedBlinkTracker } from './analysis/led-indicator-analyzer.js';
export type { LedIndicatorOptions, BlinkState } from './analysis/led-indicator-analyzer.js';

export { BrowserBarcodeScanner, createCodeObserver } from './analysis/code-scanner.js';
export type { CodeScanner, CodeScanResult } from './analysis/code-scanner.js';

export { maybeShareImage, createBrowserImageEncoder } from './analysis/image-sharing.js';
export type {
  ImageEncoder,
  ShareRequest,
  LocalImageShareAuthorization,
  ImageSharingPolicy,
  ImageSharingConfig,
  SharedImageArtifact
} from './analysis/image-sharing.js';
