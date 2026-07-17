import { createHash } from 'node:crypto';
import type { AgentRuntimeToolDefinition, Delegate, JsonValue, ResolvedDelegate } from '../../../shared';

export class DelegateAdmissionManager {
  resolve(delegate: Delegate): ResolvedDelegate {
    return {
      id: delegate.id,
      toolName: delegate.toolName,
      description: delegate.description,
      digest: digestJson(delegate as unknown as Record<string, unknown>),
      maxInputBytes: delegate.maxInputBytes,
      maxResultBytes: delegate.maxResultBytes,
      deadlineMs: delegate.deadlineMs,
      maxQueuedCalls: delegate.maxQueuedCalls
    };
  }

  runtimeTool(delegate: ResolvedDelegate): AgentRuntimeToolDefinition {
    return {
      name: delegate.toolName,
      description: delegate.description,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['message'],
        properties: {
          message: { type: 'string', minLength: 1 }
        }
      },
      binding: { kind: 'delegate', delegateId: delegate.id }
    };
  }

  validateInput(delegate: ResolvedDelegate, input: string): void {
    this.validateMessage(delegate, input, delegate.maxInputBytes, 'input');
  }

  validateResult(delegate: ResolvedDelegate, result: string): void {
    this.validateMessage(delegate, result, delegate.maxResultBytes, 'result');
  }

  private validateMessage(delegate: ResolvedDelegate, message: string, maxBytes: number, kind: 'input' | 'result'): void {
    if (message.length === 0) {
      throw new Error(`Delegate ${delegate.id} ${kind} must not be empty`);
    }
    const bytes = Buffer.byteLength(message, 'utf8');
    if (bytes > maxBytes) {
      throw new Error(`Delegate ${delegate.id} ${kind} is ${bytes} bytes; limit is ${maxBytes}`);
    }
  }
}

export function digestJson(value: JsonValue | Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}