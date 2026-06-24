export interface Clock {
  now(): string;
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}