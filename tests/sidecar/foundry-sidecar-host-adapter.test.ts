import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostManagedWorkRootUnderHome } from '../../src/sidecar/host/foundry-sidecar-host-adapter';

// Foundry only persists $HOME across idle scale-to-zero / container recycle; the image's /runtime (and every other
// writable location) is ephemeral. Host-managed storage (copilot-local capture/restore are no-ops) must therefore
// be rooted under $HOME or the workspace + Copilot session state are lost when a paused session resumes onto a fresh
// container. These assert the work-root resolution the Foundry host adapter applies at boot.

test('scenario: foundry roots the image /runtime work root under $HOME so it survives container recycle', () => {
  assert.equal(hostManagedWorkRootUnderHome('/runtime/sidecar', '/home/sidecar'), '/home/sidecar/agent-runtime');
});

test('scenario: foundry roots an unset work root under $HOME', () => {
  assert.equal(hostManagedWorkRootUnderHome(undefined, '/home/sidecar'), '/home/sidecar/agent-runtime');
  assert.equal(hostManagedWorkRootUnderHome('   ', '/home/sidecar'), '/home/sidecar/agent-runtime');
});

test('scenario: foundry keeps an operator work root that is already inside $HOME', () => {
  assert.equal(hostManagedWorkRootUnderHome('/home/sidecar/custom', '/home/sidecar'), '/home/sidecar/custom');
  assert.equal(hostManagedWorkRootUnderHome('/home/sidecar', '/home/sidecar'), '/home/sidecar');
});

test('scenario: a work root that merely name-prefixes $HOME is still relocated under $HOME', () => {
  // "/home/sidecar-other" is not inside "/home/sidecar"; resolve()-based containment must not be fooled by the prefix.
  assert.equal(hostManagedWorkRootUnderHome('/home/sidecar-other/work', '/home/sidecar'), '/home/sidecar/agent-runtime');
});
