export interface Delegate {
  id: string;
  toolName: string;
  description: string;
  maxInputBytes: number;
  maxResultBytes: number;
  deadlineMs: number;
  maxQueuedCalls: number;
}