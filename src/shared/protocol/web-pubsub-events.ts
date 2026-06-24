export const CENTRAL_EVENTS_GROUP = 'central:events';

export function sessionGroup(sessionId: string): string {
  return `session:${sessionId}`;
}

export function workerGroup(workerId: string): string {
  return `worker:${workerId}`;
}