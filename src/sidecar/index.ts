export { CopilotProcessAdapter, DockerWorkspaceAdapter, WebPubSubClientAdapter } from './adapters';
export type { SidecarAgentProcessAdapter, SidecarRuntimeTransport, SidecarWorkspaceAdapter, SidecarWorkspaceMount, WorkerRegistrationEventFactory } from './contracts';
export { HeartbeatController, LeaseCommandController, WorkerRegistrationController } from './controllers';
export { SidecarDaemon } from './sidecar-daemon';