export { CopilotProcessAdapter, DockerWorkspaceAdapter, LocalWorkspaceAdapter, WebPubSubClientAdapter } from './adapters';
export type { SidecarAgentProcessAdapter, SidecarRuntimeTransport, SidecarWorkspaceAdapter, SidecarWorkspaceMount } from './contracts';
export { HeartbeatController, LeaseCommandController } from './controllers';
export { SidecarDaemon } from './sidecar-daemon';
export { resolveWorkerType } from './worker-types';
export type { WorkerBuildProfile } from './worker-types';