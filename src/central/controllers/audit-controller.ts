import type { AuditRecord, Clock } from '../../shared';

/**
 * Creates audit records at central control-plane boundaries where runtime actions need a durable accountability trail.
 */
export class AuditController {
  constructor(private readonly clock: Clock) {}

  record(input: Omit<AuditRecord, 'auditId' | 'timestamp'>): AuditRecord {
    return { ...input, auditId: crypto.randomUUID(), timestamp: this.clock.now() };
  }
}