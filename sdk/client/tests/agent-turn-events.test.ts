import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntimeClient, AgentTurn, CasePairingError, InteractionResponseError, SessionHandle, mapSessionEvent } from '../src/agent-runtime-client';

test('scenario: delegated interaction source and interruption map into Session events', () => {
  assert.deepEqual(mapSessionEvent({
    eventId: 'interaction-requested',
    sessionId: 'parent-session',
    turnSeq: 2,
    sequence: 1,
    type: 'interaction.requested',
    timestamp: '2026-07-20T00:00:00.000Z',
    actor: 'central',
    payload: {
      interactionId: 'interaction-1',
      kind: 'approval',
      request: { action: 'run-shell' },
      source: { kind: 'delegated_session', ownerSessionId: 'child-session', agentSpecId: 'diagnostic-expert' }
    }
  }), {
    type: 'interaction.requested',
    sessionId: 'parent-session',
    turnSeq: 2,
    interactionId: 'interaction-1',
    kind: 'approval',
    request: { action: 'run-shell' },
    source: { kind: 'delegated_session', ownerSessionId: 'child-session', agentSpecId: 'diagnostic-expert' }
  });

  assert.deepEqual(mapSessionEvent({
    eventId: 'interaction-interrupted',
    sessionId: 'parent-session',
    turnSeq: 2,
    sequence: 2,
    type: 'interaction.interrupted',
    timestamp: '2026-07-20T00:00:01.000Z',
    actor: 'central',
    payload: { interactionId: 'interaction-1', kind: 'approval', reason: 'owner_lease_lost' }
  }), {
    type: 'interaction.interrupted',
    sessionId: 'parent-session',
    turnSeq: 2,
    interactionId: 'interaction-1',
    kind: 'approval',
    reason: 'owner_lease_lost'
  });
});

test('scenario: interaction response waits for a typed private acknowledgement', async () => {
  const client = new AgentRuntimeClient({ centralUrl: 'http://central.test', tenantId: 'tenant-1' });
  const runtime = client as unknown as {
    waitForAcknowledgement(ackId: string, expectedType: string): Promise<unknown>;
    publishTenantEvent(input: { ackId?: string }): Promise<void>;
  };
  let publishedAckId: string | undefined;
  runtime.waitForAcknowledgement = async (_ackId, expectedType) => {
    assert.equal(expectedType, 'interaction.responded.ack');
    return {
      eventId: 'interaction-ack',
      sessionId: 'session-1',
      sequence: 0,
      type: 'interaction.responded.ack',
      timestamp: '2026-07-20T00:00:00.000Z',
      actor: 'central',
      payload: { interactionId: 'interaction-1', status: 'already_resolved' }
    };
  };
  runtime.publishTenantEvent = async (input) => { publishedAckId = input.ackId; };

  const result = await new SessionHandle(client, 'session-1', 'running').respondToInteraction({
    interactionId: 'interaction-1',
    decision: 'approved'
  });

  assert.ok(publishedAckId);
  assert.deepEqual(result, { status: 'already_resolved' });
});

test('scenario: rejected interaction acknowledgement throws a typed error', async () => {
  const client = new AgentRuntimeClient({ centralUrl: 'http://central.test', tenantId: 'tenant-1' });
  const runtime = client as unknown as {
    waitForAcknowledgement(ackId: string, expectedType: string): Promise<unknown>;
    publishTenantEvent(input: unknown): Promise<void>;
  };
  runtime.waitForAcknowledgement = async () => ({
    eventId: 'interaction-ack',
    sessionId: 'session-1',
    sequence: 0,
    type: 'interaction.responded.ack',
    timestamp: '2026-07-20T00:00:00.000Z',
    actor: 'central',
    payload: {
      interactionId: 'interaction-1',
      status: 'rejected',
      error: { code: 'interaction_response_rejected', message: 'not authorized' }
    }
  });
  runtime.publishTenantEvent = async () => undefined;

  await assert.rejects(
    new SessionHandle(client, 'session-1', 'running').respondToInteraction({ interactionId: 'interaction-1', decision: 'approved' }),
    (error: unknown) => error instanceof InteractionResponseError && error.code === 'interaction_response_rejected'
  );
});

test('scenario: session list preserves a delegated session parent relationship', async () => {
  const client = new AgentRuntimeClient({ centralUrl: 'http://central.test', tenantId: 'tenant-1' });
  const runtime = client as unknown as {
    waitForAcknowledgement(ackId: string, expectedType: string): Promise<unknown>;
    publishTenantEvent(input: unknown): Promise<void>;
  };
  runtime.waitForAcknowledgement = async (_ackId, expectedType) => {
    assert.equal(expectedType, 'session.listed');
    return {
      eventId: 'event-session-listed',
      sequence: 0,
      type: 'session.listed',
      timestamp: '2026-07-15T00:00:00.000Z',
      actor: 'central',
      payload: {
        sessions: [{
          sessionId: 'child-session',
          parentSessionId: 'parent-session',
          status: 'paused',
          resolvedAgentSpec: { agentSpecId: 'copilot-foundry' },
          owner: 'owner-1',
          eventCursor: 4,
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T00:01:00.000Z'
        }]
      }
    };
  };
  runtime.publishTenantEvent = async () => undefined;

  assert.deepEqual(await client.sessions.list(), [{
    sessionId: 'child-session',
    parentSessionId: 'parent-session',
    status: 'paused',
    agentSpecId: 'copilot-foundry',
    owner: 'owner-1',
    eventCursor: 4,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:01:00.000Z'
  }]);
});

test('scenario: cases.createPairingInvite mints a one-time invite for the operator case', async () => {
  const client = new AgentRuntimeClient({ centralUrl: 'http://central.test', tenantId: 'tenant-1' });
  const runtime = client as unknown as {
    waitForAcknowledgement(ackId: string, expectedType: string): Promise<unknown>;
    publishTenantEvent(input: { type: string; payload?: unknown; ackId?: string }): Promise<void>;
  };
  let requested: { type: string; payload?: unknown } | undefined;
  runtime.publishTenantEvent = async (input) => { requested = input; };
  runtime.waitForAcknowledgement = async (_ackId, expectedType) => {
    assert.equal(expectedType, 'case.pairing.minted');
    return {
      eventId: 'event-pairing-minted',
      sequence: 0,
      type: 'case.pairing.minted',
      timestamp: '2026-07-22T00:00:00.000Z',
      actor: 'central',
      payload: {
        invite: {
          caseId: 'case-parent-1',
          inviteId: 'invite-abc',
          inviteSecret: 'secret-xyz',
          expiresAt: '2026-07-22T00:05:00.000Z'
        }
      }
    };
  };

  const invite = await client.cases.createPairingInvite('case-parent-1');

  assert.equal(requested?.type, 'case.pairing.mint.requested');
  assert.deepEqual((requested?.payload as { caseId: string }).caseId, 'case-parent-1');
  assert.deepEqual(invite, {
    caseId: 'case-parent-1',
    inviteId: 'invite-abc',
    inviteSecret: 'secret-xyz',
    expiresAt: '2026-07-22T00:05:00.000Z'
  });
});

test('scenario: cases.listDevices returns the case-scoped roster with live worker state', async () => {
  const client = new AgentRuntimeClient({ centralUrl: 'http://central.test', tenantId: 'tenant-1' });
  const runtime = client as unknown as {
    waitForAcknowledgement(ackId: string, expectedType: string): Promise<unknown>;
    publishTenantEvent(input: { type: string; payload?: unknown; ackId?: string }): Promise<void>;
  };
  let requested: { type: string; payload?: unknown } | undefined;
  runtime.publishTenantEvent = async (input) => { requested = input; };
  runtime.waitForAcknowledgement = async (_ackId, expectedType) => {
    assert.equal(expectedType, 'case.devices.provided');
    return {
      eventId: 'event-case-devices',
      sequence: 0,
      type: 'case.devices.provided',
      timestamp: '2026-07-22T00:00:00.000Z',
      actor: 'central',
      payload: {
        devices: [
          {
            deviceRef: 'dref_a',
            deviceLabel: 'iOS device',
            online: true,
            ready: true,
            busy: false,
            workerId: 'worker-a',
            lastHeartbeatAt: '2026-07-22T00:00:00.000Z',
            lastRedeemedAt: '2026-07-22T00:00:00.000Z'
          },
          {
            deviceRef: 'dref_b',
            deviceLabel: 'Android device',
            online: false,
            ready: false,
            busy: false,
            lastRedeemedAt: '2026-07-22T00:00:00.000Z'
          }
        ]
      }
    };
  };

  const devices = await client.cases.listDevices('case-parent-1');

  assert.equal(requested?.type, 'case.devices.requested');
  assert.deepEqual((requested?.payload as { caseId: string }).caseId, 'case-parent-1');
  assert.equal(devices.length, 2);
  assert.equal(devices[0].deviceRef, 'dref_a');
  assert.equal(devices[0].online, true);
  assert.equal(devices[0].workerId, 'worker-a');
  assert.equal(devices[1].deviceRef, 'dref_b');
  assert.equal(devices[1].online, false);
  assert.equal(devices[1].workerId, undefined);
});

test('scenario: a case-scoped roster error surfaces as a typed CasePairingError, not a silent empty roster', async () => {
  const client = new AgentRuntimeClient({ centralUrl: 'http://central.test', tenantId: 'tenant-1' });
  const runtime = client as unknown as {
    waitForAcknowledgement(ackId: string, expectedType: string): Promise<unknown>;
    publishTenantEvent(input: unknown): Promise<void>;
  };
  runtime.publishTenantEvent = async () => undefined;
  runtime.waitForAcknowledgement = async () => ({
    eventId: 'event-case-devices',
    sequence: 0,
    type: 'case.devices.provided',
    timestamp: '2026-07-22T00:00:00.000Z',
    actor: 'central',
    payload: { error: { code: 'case_not_owned', message: 'caller does not own this case' } }
  });

  await assert.rejects(
    client.cases.listDevices('case-parent-1'),
    (error: unknown) => error instanceof CasePairingError && error.code === 'case_not_owned'
  );
});

test('scenario: explicit turn completed event completes the turn after final agent output', async () => {
  const runtime = {
    async subscribeSessionEvents(_input: { sessionId: string }, handler: (event: unknown) => void) {
      queueMicrotask(() => {
        handler({
          eventId: 'event-agent-output',
          sequence: 1,
          type: 'agent.output',
          timestamp: '2026-06-25T00:00:00.000Z',
          actor: 'sidecar',
          sessionId: 'session-1',
          turnSeq: 2,
          payload: {
            message: 'done',
            output: { content: 'done' },
            internalEvent: {
              type: 'assistant.message',
              data: { content: 'done' }
            }
          }
        });
        handler({
          eventId: 'event-turn-completed',
          sequence: 2,
          type: 'turn.completed',
          timestamp: '2026-06-25T00:00:01.000Z',
          actor: 'sidecar',
          sessionId: 'session-1',
          turnSeq: 2,
          payload: {
            result: {
              message: 'done',
              output: { content: 'done' }
            }
          }
        });
      });
      return { close: async () => undefined };
    },
    async readSessionEvents() {
      return [];
    }
  };

  const turn = new AgentTurn(runtime as never, 'session-1', 2);
  const events = [];
  for await (const event of turn.events()) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: 'turn.started', sessionId: 'session-1', turnSeq: 2 },
    { type: 'agent.internal', sessionId: 'session-1', turnSeq: 2, label: 'assistant.message', detail: { content: 'done' } },
    {
      type: 'turn.completed',
      sessionId: 'session-1',
      turnSeq: 2,
      result: {
        sessionId: 'session-1',
        turnSeq: 2,
        message: 'done',
        output: { content: 'done' }
      }
    }
  ]);
});

test('scenario: persisted terminal event completes a turn even when live subscription missed it', async () => {
  const runtime = {
    async subscribeSessionEvents() {
      return { close: async () => undefined };
    },
    async readSessionEvents() {
      return [{
        eventId: 'event-turn-failed-before-subscribe',
        sequence: 3,
        type: 'turn.failed',
        timestamp: '2026-06-25T00:00:01.000Z',
        actor: 'central',
        sessionId: 'session-1',
        turnSeq: 2,
        payload: {
          error: {
            message: 'session has no current worker',
            code: 'no_current_worker'
          }
        }
      }];
    }
  };

  const turn = new AgentTurn(runtime as never, 'session-1', 2);
  const events = [];
  for await (const event of turn.events()) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: 'turn.started', sessionId: 'session-1', turnSeq: 2 },
    {
      type: 'turn.failed',
      sessionId: 'session-1',
      turnSeq: 2,
      error: {
        message: 'session has no current worker',
        code: 'no_current_worker',
        details: undefined
      }
    }
  ]);
});

test('scenario: live terminal event completes a turn while replay acknowledgement is pending', async () => {
  const runtime = {
    async subscribeSessionEvents(_input: { sessionId: string }, handler: (event: unknown) => void) {
      queueMicrotask(() => {
        handler({
          eventId: 'event-turn-completed-live',
          sequence: 2,
          type: 'turn.completed',
          timestamp: '2026-06-25T00:00:01.000Z',
          actor: 'sidecar',
          sessionId: 'session-1',
          turnSeq: 2,
          payload: {
            result: {
              message: 'live done'
            }
          }
        });
      });
      return { close: async () => undefined };
    },
    async readSessionEvents() {
      await new Promise(() => undefined);
      return [];
    }
  };

  const turn = new AgentTurn(runtime as never, 'session-1', 2);
  const events = [];
  for await (const event of turn.events()) {
    events.push(event);
  }

  assert.deepEqual(events, [
    { type: 'turn.started', sessionId: 'session-1', turnSeq: 2 },
    {
      type: 'turn.completed',
      sessionId: 'session-1',
      turnSeq: 2,
      result: {
        sessionId: 'session-1',
        turnSeq: 2,
        message: 'live done',
        output: undefined
      }
    }
  ]);
});

test('scenario: session history reads replay acknowledgement from client private inbox', async () => {
  const client = new AgentRuntimeClient({ centralUrl: 'http://central.test', tenantId: 'tenant-1' });
  const publishedEvents: Array<{ type: string; sessionId?: string; ackId?: string; payload?: unknown }> = [];
  const runtime = client as unknown as {
    waitForAcknowledgement(ackId: string, expectedType: string): Promise<unknown>;
    publishTenantEvent(input: unknown): Promise<void>;
    subscribeSessionEvents(input: unknown, handler: (event: unknown) => void): Promise<unknown>;
  };
  runtime.waitForAcknowledgement = async (ackId, expectedType) => {
    assert.equal(expectedType, 'session.events.replayed');
    return {
      eventId: 'event-history-replayed',
      sequence: 0,
      type: 'session.events.replayed',
      timestamp: '2026-06-25T00:00:00.000Z',
      actor: 'central',
      sessionId: 'session-1',
      ackId,
      payload: {
        events: [{
          eventId: 'event-session-created',
          sequence: 1,
          type: 'session.created',
          timestamp: '2026-06-25T00:00:00.000Z',
          actor: 'central',
          sessionId: 'session-1',
          payload: { input: { message: 'hello' } }
        }]
      }
    };
  };
  runtime.publishTenantEvent = async (input) => {
    assert.equal(typeof input, 'object');
    assert.notEqual(input, null);
    publishedEvents.push(input as typeof publishedEvents[number]);
  };
  runtime.subscribeSessionEvents = async () => {
    throw new Error('history replay should use the client private acknowledgement path');
  };

  const events = await client.readSessionEvents({ sessionId: 'session-1', afterSequence: 3 });

  assert.deepEqual(publishedEvents.map((event) => event.type), ['session.events.requested']);
  assert.deepEqual(publishedEvents[0], {
    type: 'session.events.requested',
    sessionId: 'session-1',
    ackId: publishedEvents[0].ackId,
    payload: {
      afterSequence: 3
    }
  });
  assert.deepEqual(events.map((event) => event.type), ['session.created']);
});

test('scenario: session pause publishes runtime pause command', async () => {
  const publishedEvents: Array<{ type: string; sessionId?: string; payload?: unknown }> = [];
  const runtime = {
    async publishTenantEvent(input: unknown) {
      assert.equal(typeof input, 'object');
      assert.notEqual(input, null);
      publishedEvents.push(input as typeof publishedEvents[number]);
    }
  };
  const session = new SessionHandle(runtime as never, 'session-1', 'running');

  await session.pause();

  assert.deepEqual(publishedEvents, [{
    type: 'session.pause.requested',
    sessionId: 'session-1',
    payload: {}
  }]);
});
