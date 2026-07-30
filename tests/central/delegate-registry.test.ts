import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentSpec, Delegate } from '../../src/shared';
import { StaticDelegateBindingIndex, StaticDelegateRegistry } from '../../src/central/registries/delegate-registry';
import { DelegateAdmissionManager } from '../../src/central/managers';

const DELEGATE: Delegate = {
  id: 'copilot-foundry',
  toolName: 'copilot_foundry',
  description: 'Ask the copilot-foundry subagent to handle the request.',
  maxInputBytes: 2048,
  maxResultBytes: 8192,
  deadlineMs: 120_000,
  maxQueuedCalls: 2
};

test('scenario: registered Delegate resolves one callee and allows multiple callers', () => {
  const registry = new StaticDelegateRegistry([DELEGATE]);
  const callee = agentSpec('answer-specialist', [], [DELEGATE.id]);
  const bindings = new StaticDelegateBindingIndex(registry, [
    agentSpec('caller-a', [DELEGATE.id], []),
    agentSpec('caller-b', [DELEGATE.id], []),
    callee
  ]);

  assert.equal(registry.resolve(DELEGATE.id), DELEGATE);
  assert.equal(bindings.resolveCallee(DELEGATE.id), callee);
});

test('scenario: Delegate config rejects unknown refs and ambiguous callee bindings', () => {
  const registry = new StaticDelegateRegistry([DELEGATE]);

  assert.throws(
    () => new StaticDelegateBindingIndex(registry, [agentSpec('caller', ['unknown'], []), agentSpec('callee', [], [DELEGATE.id])]),
    /AgentSpec caller asCaller references unknown Delegate unknown/
  );
  assert.throws(
    () => new StaticDelegateBindingIndex(registry, [agentSpec('caller', [DELEGATE.id], [])]),
    /Delegate copilot-foundry has no callee AgentSpec/
  );
  assert.throws(
    () => new StaticDelegateBindingIndex(registry, [agentSpec('callee-a', [], [DELEGATE.id]), agentSpec('callee-b', [], [DELEGATE.id])]),
    /Delegate copilot-foundry has multiple callee AgentSpecs/
  );
});

test('scenario: a device delegate lets the real agent omit the Central-bound operator target', () => {
  const admission = new DelegateAdmissionManager();
  const tool = admission.runtimeTool(admission.resolve({ ...DELEGATE, targetPolicy: 'device' }));
  const schema = tool.inputSchema as { required: string[]; properties: Record<string, unknown> };

  assert.deepEqual(schema.required, ['message']);
  assert.ok(schema.properties.target, 'the agent may echo the exact target for diagnostics');
});

function agentSpec(agentSpecId: string, asCaller: string[], asCallee: string[]): AgentSpec {
  return {
    agentSpecId,
    labels: {},
    launch: { command: 'agent', args: [] },
    instructions: 'Test agent instructions.',
    toolProfile: 'test-tools',
    delegateRefs: { asCaller, asCallee },
    workerSelector: { matchLabels: { agent: agentSpecId } },
    pausePolicy: 'stop-on-pause',
    recoveryPolicy: 'restart-with-context',
    idlePauseTimeoutMs: 120_000,
    version: 'test-v1'
  };
}