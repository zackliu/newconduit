import type { AuditRecord, Clock } from '../../shared';

export class AuditController {
  constructor(private readonly clock: Clock) {}

  record(input: Omit<AuditRecord, 'auditId' | 'timestamp'>): AuditRecord {
    return { ...input, auditId: crypto.randomUUID(), timestamp: this.clock.now() };
  }
}