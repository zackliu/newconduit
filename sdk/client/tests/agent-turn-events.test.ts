import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntimeClient, AgentTurn, SessionHandle } from '../src/agent-runtime-client';

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
