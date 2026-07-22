import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  esc,
  fmtPct,
  severityClass,
  shortId,
  computeDeviceStages,
  computeScanRoute,
  isTerminalChildStatus
} from '../src/ui.js';

/**
 * UI-safety and formatting unit tests for the console + Device Scan views. Both roles build their DOM by
 * interpolating runtime values (device labels, decoded barcode text, observation summaries, quality scores)
 * straight into `innerHTML`, so these pure helpers are the layer that keeps that rendering correct and safe.
 */

test('esc neutralizes HTML so an untrusted device label or decoded code cannot inject markup', () => {
  const hostile = '<img src=x onerror="alert(1)">"drop" & \'run\'';
  const escaped = esc(hostile);
  assert.ok(!escaped.includes('<'), 'angle brackets must be encoded');
  assert.ok(!escaped.includes('>'), 'angle brackets must be encoded');
  assert.equal(
    escaped,
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&quot;drop&quot; &amp; &#39;run&#39;'
  );
});

test('esc renders nullish values as an empty string instead of "null"/"undefined"', () => {
  assert.equal(esc(undefined), '');
  assert.equal(esc(null), '');
  assert.equal(esc(0), '0');
});

test('fmtPct renders a 0..1 signal as a rounded whole-percent badge', () => {
  assert.equal(fmtPct(0), '0%');
  assert.equal(fmtPct(0.5), '50%');
  assert.equal(fmtPct(1), '100%');
  assert.equal(fmtPct(0.833), '83%');
});

test('severityClass maps observation severities to their pill CSS classes', () => {
  assert.equal(severityClass('issue'), 'sev-issue');
  assert.equal(severityClass('warn'), 'sev-warn');
  assert.equal(severityClass('info'), 'sev-info');
  assert.equal(severityClass('anything-else'), 'sev-ok');
});

test('shortId keeps short ids, truncates long session ids, and shows a dash when absent', () => {
  assert.equal(shortId(undefined), '—');
  assert.equal(shortId('abc123'), 'abc123');
  const long = 'session-0123456789abcdef';
  const short = shortId(long);
  assert.ok(short.length < long.length, 'a long id must be shortened');
  assert.ok(short.includes('…'), 'a shortened id keeps an ellipsis marker');
  assert.ok(short.startsWith('session-'), 'the shortened id keeps a readable prefix');
});

const IDLE = {
  online: false,
  busy: false,
  assigned: false,
  childRunning: false,
  hasIncompleteRecord: false,
  hasEvidence: false
};

test('computeDeviceStages marks the device online/paired before any scan is delegated', () => {
  const stages = computeDeviceStages({ ...IDLE, online: true });
  assert.deepEqual(stages.map((stage) => stage.state), ['active', 'idle', 'idle', 'idle']);
  assert.equal(stages[0].label, 'Paired · online');
});

test('computeDeviceStages advances to scan-delegated only once a child is assigned', () => {
  const stages = computeDeviceStages({ ...IDLE, online: true, assigned: true });
  assert.deepEqual(stages.map((stage) => stage.state), ['done', 'active', 'idle', 'idle']);
});

test('computeDeviceStages reflects an in-progress capture without conflating it with received evidence', () => {
  const running = computeDeviceStages({ ...IDLE, online: true, assigned: true, childRunning: true });
  assert.deepEqual(running.map((stage) => stage.state), ['done', 'done', 'active', 'idle']);
  const busy = computeDeviceStages({ ...IDLE, online: true, assigned: true, busy: true });
  assert.deepEqual(busy.map((stage) => stage.state), ['done', 'done', 'active', 'idle']);
});

test('computeDeviceStages completes all stages once structured evidence is received', () => {
  const stages = computeDeviceStages({ ...IDLE, online: true, assigned: true, hasEvidence: true });
  assert.deepEqual(stages.map((stage) => stage.state), ['done', 'done', 'done', 'active']);
});

test('computeDeviceStages keeps every stage idle while no device is paired', () => {
  const stages = computeDeviceStages(IDLE);
  assert.deepEqual(stages.map((stage) => stage.state), ['idle', 'idle', 'idle', 'idle']);
});

test('isTerminalChildStatus flags a failed/cancelled delegated child but not a live or transient one', () => {
  assert.equal(isTerminalChildStatus('failed'), true, 'worker loss fails the child session');
  assert.equal(isTerminalChildStatus('cancelled'), true);
  assert.equal(isTerminalChildStatus('running'), false);
  assert.equal(isTerminalChildStatus('queued'), false);
  assert.equal(isTerminalChildStatus('completed'), false, 'a clean end is not a routing loss');
  assert.equal(isTerminalChildStatus(undefined), false);
});

test('computeScanRoute surfaces device-lost so a lost worker never spins as silent working', () => {
  const lost = computeScanRoute({ scanActive: false, childTerminated: true, deviceOnline: false });
  assert.equal(lost, 'device-lost');
  // device-lost takes precedence even if a worker view briefly still reads online during teardown.
  const lostWhileOnline = computeScanRoute({ scanActive: true, childTerminated: true, deviceOnline: true });
  assert.equal(lostWhileOnline, 'device-lost');
});

test('computeScanRoute distinguishes awaiting-device (offline, no fallback) from an in-flight scan', () => {
  const awaiting = computeScanRoute({ scanActive: true, childTerminated: false, deviceOnline: false });
  assert.equal(awaiting, 'awaiting-device');
  const inFlight = computeScanRoute({ scanActive: true, childTerminated: false, deviceOnline: true });
  assert.equal(inFlight, 'in-flight');
  const idle = computeScanRoute({ scanActive: false, childTerminated: false, deviceOnline: true });
  assert.equal(idle, 'idle');
});
