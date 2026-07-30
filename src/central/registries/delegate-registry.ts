import type { AgentSpec, Delegate, ResolvedDelegate } from '../../shared';
import type { DelegateAdmissionManager } from '../managers/admission/delegate-admission-manager';

export interface DelegateRegistry {
  resolve(delegateId: string): Delegate;
  list(): Delegate[];
}

export class StaticDelegateRegistry implements DelegateRegistry {
  private readonly delegatesById: ReadonlyMap<string, Delegate>;

  constructor(delegates: Delegate[]) {
    const delegatesById = new Map<string, Delegate>();
    const delegateIdsByToolName = new Map<string, string>();
    for (const delegate of delegates) {
      validateDelegate(delegate);
      if (delegatesById.has(delegate.id)) {
        throw new Error(`duplicate Delegate id: ${delegate.id}`);
      }
      const existingTool = delegateIdsByToolName.get(delegate.toolName);
      if (existingTool) {
        throw new Error(`Delegate toolName ${delegate.toolName} is used by both ${existingTool} and ${delegate.id}`);
      }
      delegatesById.set(delegate.id, delegate);
      delegateIdsByToolName.set(delegate.toolName, delegate.id);
    }
    this.delegatesById = delegatesById;
  }

  resolve(delegateId: string): Delegate {
    const delegate = this.delegatesById.get(delegateId);
    if (!delegate) {
      throw new Error(`unknown Delegate id: ${delegateId}`);
    }
    return delegate;
  }

  list(): Delegate[] {
    return [...this.delegatesById.values()];
  }
}

export interface DelegateBindingIndex {
  resolveCallee(delegateId: string): AgentSpec;
}

export class StaticDelegateBindingIndex implements DelegateBindingIndex {
  private readonly calleesByDelegateId: ReadonlyMap<string, AgentSpec>;

  constructor(delegateRegistry: DelegateRegistry, agentSpecs: AgentSpec[]) {
    const calleesByDelegateId = new Map<string, AgentSpec>();

    for (const agentSpec of agentSpecs) {
      validateReferences(delegateRegistry, agentSpec, 'asCaller');
      validateReferences(delegateRegistry, agentSpec, 'asCallee');

      for (const delegateId of agentSpec.delegateRefs.asCallee) {
        const existing = calleesByDelegateId.get(delegateId);
        if (existing) {
          throw new Error(`Delegate ${delegateId} has multiple callee AgentSpecs: ${existing.agentSpecId}, ${agentSpec.agentSpecId}`);
        }
        calleesByDelegateId.set(delegateId, agentSpec);
      }
    }

    for (const delegate of delegateRegistry.list()) {
      if (!calleesByDelegateId.has(delegate.id)) {
        throw new Error(`Delegate ${delegate.id} has no callee AgentSpec`);
      }
    }

    this.calleesByDelegateId = calleesByDelegateId;
  }

  resolveCallee(delegateId: string): AgentSpec {
    const callee = this.calleesByDelegateId.get(delegateId);
    if (!callee) {
      throw new Error(`Delegate ${delegateId} has no callee AgentSpec`);
    }
    return callee;
  }
}

function validateDelegate(delegate: Delegate): void {
  requireNonEmpty(delegate.id, 'Delegate id');
  requireNonEmpty(delegate.toolName, `Delegate ${delegate.id} toolName`);
  requireNonEmpty(delegate.description, `Delegate ${delegate.id} description`);
  requirePositiveInteger(delegate.maxInputBytes, `Delegate ${delegate.id} maxInputBytes`);
  requirePositiveInteger(delegate.maxResultBytes, `Delegate ${delegate.id} maxResultBytes`);
  requirePositiveInteger(delegate.deadlineMs, `Delegate ${delegate.id} deadlineMs`);
  requirePositiveInteger(delegate.maxQueuedCalls, `Delegate ${delegate.id} maxQueuedCalls`);
  if (delegate.targetPolicy !== undefined && delegate.targetPolicy !== 'pool' && delegate.targetPolicy !== 'device') {
    throw new Error(`Delegate ${delegate.id} targetPolicy must be 'pool' or 'device'`);
  }
}

function validateReferences(delegateRegistry: DelegateRegistry, agentSpec: AgentSpec, role: keyof AgentSpec['delegateRefs']): void {
  const refs = agentSpec.delegateRefs[role];
  if (new Set(refs).size !== refs.length) {
    throw new Error(`AgentSpec ${agentSpec.agentSpecId} has duplicate ${role} Delegate refs`);
  }
  for (const delegateId of refs) {
    try {
      delegateRegistry.resolve(delegateId);
    } catch {
      throw new Error(`AgentSpec ${agentSpec.agentSpecId} ${role} references unknown Delegate ${delegateId}`);
    }
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new Error(`${field} must not be empty`);
  }
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

export interface ResolvedDelegateRegistry {
  resolve(delegateId: string): ResolvedDelegate;
}

export class StaticResolvedDelegateRegistry implements ResolvedDelegateRegistry {
  private readonly delegatesById: ReadonlyMap<string, ResolvedDelegate>;

  constructor(input: {
    delegates: Delegate[];
    admissionManager: DelegateAdmissionManager;
  }) {
    this.delegatesById = new Map(input.delegates.map((delegate) => [delegate.id, input.admissionManager.resolve(delegate)]));
  }

  resolve(delegateId: string): ResolvedDelegate {
    const delegate = this.delegatesById.get(delegateId);
    if (!delegate) {
      throw new Error(`unknown resolved Delegate id: ${delegateId}`);
    }
    return delegate;
  }
}