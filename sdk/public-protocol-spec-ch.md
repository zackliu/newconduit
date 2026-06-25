# Agent Runtime Sidecar SDK Public Protocol Spec

状态：SDK public protocol spec  
读者：SDK implementer、runtime owner、sidecar owner、e2e test owner

## 1. 边界

SDK 是客户侧代码，目录固定在 `sdk/`。`src/` 是服务提供商 runtime implementation。SDK 不 import `src/`，不 import `src/shared`，不复用 central、sidecar、storage、controller、adapter implementation code。

SDK 与 runtime 的共享点是 public protocol，不是代码共享。Public protocol 以本文件为 SDK 侧 source of truth。Central、sidecar、SDK、e2e tests 修改 public protocol 时必须同步本文件。

## 2. POC 传输形态

SDK POC 只使用两类入口：

1. REST 到 central：只用于 negotiate Web PubSub client access URL。
2. Web PubSub client connection：用于所有 session command、session query 和 turn event 交互。

Session create、list、history、input、pause、resume、cancel 都必须走 Web PubSub tenant inbox。SDK 和 central 不提供第二条 HTTP session command/query 路径。Session catalog 和 event history 仍然是 central-owned persisted truth；区别是读取请求也通过 runtime channel 发起，并通过 client inbox acknowledgement 返回。SDK 不直接连接 Worker endpoint。SDK 不读取 Worker address、Docker container、WorkerPool source、sidecar process state。

Central 的实现分层必须保持清晰：处理 Web PubSub runtime event、REST negotiate、未来 gRPC/queue 等入口协议的类称为 Controller，代表可替换的协议边界；维护 session lifecycle、turn sequence、assignment、event log、worker registry/lease 等 tenant 内部流程和状态机制的类称为 Manager。`TenantRuntime` 只作为 tenant-scoped composition root 和 ingress shell，负责组装 controllers/managers 并把 transport ingress 委托出去，不直接承载每条 session command workflow。

## 3. REST Endpoint

### Client Negotiate

```text
POST /client/negotiate?tenantId=<tenantId>&clientConnectionId=<client-startup-random-string>
```

Request body：POC 为空。

Response body：

```json
{
  "url": "<web-pubsub-client-access-url>",
  "clientInbox": {},
  "clientPrivateInbox": {
    "clientConnectionId": "<client-startup-random-string>"
  }
}
```

SDK 行为：

- SDK 使用 caller 提供的 `centralUrl` 和 `tenantId` 组装 negotiate URL。
- SDK 不把 principal、owner、role 写入 create session payload。
- SDK 将 response `url` 交给 Web PubSub client。
- SDK 建立 Web PubSub connection 后必须 join tenant-scoped `client-inbox` runtime channel 和 `client-private-inbox` runtime channel。`client-inbox` 用于 session 本体状态和 catalog 投影；`client-private-inbox` 用于只属于当前 SDK connection 的 request acknowledgement 和 query response。

## 4. Runtime Channels

SDK 使用 runtime channel 概念，不把 Web PubSub group name 暴露给 SDK public API。

| Runtime channel | SDK 用途 | Web PubSub group 映射 |
| --- | --- | --- |
| tenant inbox | publish session create/list/history/input/pause/resume/cancel request events | `tenant:{tenantId}:central:events` |
| client inbox | receive tenant-visible session resource projection and catalog updates | `tenant:{tenantId}:clients` |
| client private inbox | receive request acknowledgements and query responses for this SDK connection | `tenant:{tenantId}:client:{clientConnectionId}:inbox` |
| session events | receive attached session content, replayed history, input acknowledgement, agent output, and turn terminal events | `tenant:{tenantId}:session:{sessionId}` |

Worker commands channel 不属于 SDK public API。

`client-inbox` 在 POC 中是 tenant-scoped。它不承载 request-specific response，也不承载大体量 session content stream。Session 内部内容、agent output、tool/approval events、`turn.completed` 和 `turn.failed` 都属于 `session-events`。Central 可以把 session resource/status summary 发到 `client-inbox`，让 session list 和状态投影不依赖用户是否 attach 了该 session。

`client-private-inbox` 使用 SDK/client 启动时生成的随机 `clientConnectionId`。SDK 在 `/client/negotiate` 中提交该 id，central 只用它授权当前 Web PubSub connection join 对应 private inbox，并把该 request context 后续产生的 acknowledgement/response 路由回这个 private inbox。所有 request acknowledgement 和 query response 都走这里。SDK 不从 `client-inbox` resolve request promises。这样同一个 full session event 不会同时从 tenant-wide projection channel 和 session content channel 进入 SDK。

Client-visible source-of-truth rules:

- `session-events` is the source of truth for session content and persisted session history.
- `client-private-inbox` is the source of truth for request acknowledgement and query response correlation.
- `client-inbox` is only a tenant projection/update stream; applications treat it as an invalidation or summary signal, not as session content history.
- A full session event must not be delivered on both `client-inbox` and `session-events`. If the same durable fact needs both a request acknowledgement and a session history event, central emits different event types with different payload contracts.

## 5. SDK Public API

POC SDK public API 以 durable session 和 agent turn 为默认抽象，不把 runtime channel、Web PubSub group、raw cursor 或 worker assignment 暴露给 app code。

```ts
interface AgentRuntimeClientOptions {
  centralUrl: string;
  tenantId: string;
}

class AgentRuntimeClient {
  readonly sessions: SessionClient;
  connect(): Promise<void>;
  subscribeClientEvents(handler: (event: SdkRuntimeEvent) => void): Promise<SdkSubscription>;
  close(): Promise<void>;
}

class SessionClient {
  list(): Promise<SessionSummary[]>;
  start(input: StartSessionInput): Promise<StartSessionResult>;
  open(sessionId: string): Promise<SessionHandle>;
}

interface SessionSummary {
  sessionId: string;
  status: SessionStatus;
  agentSpecId: string;
  owner: string;
  eventCursor: number;
  createdAt: string;
  updatedAt: string;
}

interface StartSessionResult {
  session: SessionHandle;
  turn: AgentTurn;
}

class SessionHandle {
  readonly id: string;
  send(input: SessionInput): Promise<AgentTurn>;
  history(afterSequence?: number): Promise<SdkRuntimeEvent[]>;
  status(): Promise<SessionStatus>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

class AgentTurn {
  readonly id: string;
  readonly sequence: number;
  events(options?: TurnEventOptions): AsyncIterable<AgentTurnEvent>;
  waitForResult(options?: WaitForResultOptions): Promise<AgentTurnResult>;
}
```

`connect()` 调用 central negotiate 并建立 Web PubSub client connection。`ackId` 只用于 request/ack correlation，由 SDK 生成。`sessionId` 是 central-owned durable session identity，client 不能指定。`turnSeq` 是 central-owned、session-scoped、单调递增的 turn identity。

`sessions.list()` 生成 `ackId`，publish `session.list.requested` 到 tenant inbox，并等待 `client-private-inbox` 上带同一 `ackId` 的 `session.listed` response。

`sessions.start()` 可以 lazy connect；它由 SDK 生成 `ackId`，publish `session.create.requested` 到 tenant inbox，然后等待 `client-private-inbox` 上带同一 `ackId` 的 `session.created.ack` acknowledgement。Central 生成 durable `sessionId`，并为 initial input 分配 session-scoped `turnSeq = 1`。SDK 收到 acknowledgement 后返回 `StartSessionResult`。Full `session.created` event, initial input, and session content remain available through the session events channel and persisted history replay.

`sessions.open(sessionId)` 只返回现有 durable session 的本地 handle，不改变 session lifecycle。`session.resume()` 才是 runtime lifecycle command，会 publish `session.resume.requested`。

`session.history(afterSequence)` 生成 `ackId`，publish `session.events.requested` 到 tenant inbox，并等待 `client-private-inbox` 上带同一 `ackId` 的 `session.events.replayed` response。Live turn streaming uses the session events runtime channel.

`session.send()` 生成 `ackId`，publish `input.received` 到 tenant inbox，并等待 `client-private-inbox` 上带同一 `ackId` 的 `input.accepted.ack` acknowledgement。Central 为该 input 分配下一个 `turnSeq`，SDK 收到 acknowledgement 后返回对应 `AgentTurn`。Full `input.accepted` event is published to the session events channel as part of the session content/history stream. `turn.events()` 必须先订阅 session events runtime channel，再通过 `session.events.requested` replay persisted event history，并按 `eventId` 去重；这样即使 terminal event 在 SDK 开始消费 turn 前已经持久化并 fan-out，SDK 也不会错过。`turn.waitForResult()` 消费同一组 turn events，等待该 turn 的最终 result 或 failed event。

## 6. Runtime Event Envelope

```ts
type SdkRuntimeEventType =
  | 'session.create.requested'
  | 'session.created'
  | 'session.created.ack'
  | 'session.catalog.updated'
  | 'session.status.updated'
  | 'session.list.requested'
  | 'session.listed'
  | 'session.events.requested'
  | 'session.events.replayed'
  | 'input.received'
  | 'input.accepted'
  | 'input.accepted.ack'
  | 'agent.output'
  | 'turn.completed'
  | 'turn.failed'
  | 'status.changed'
  | 'session.pause.requested'
  | 'session.resume.requested'
  | 'session.cancel.requested'
  | 'session.assign'
  | 'session.paused'
  | 'session.resumed'
  | 'session.cancelled'
  | 'session.lease.lost';

interface SdkRuntimeEvent<TPayload = unknown> {
  eventId: string;
  sessionId?: string;
  workerId?: string;
  ackId?: string;
  turnSeq?: number;
  sequence: number;
  type: SdkRuntimeEventType;
  timestamp: string;
  actor: 'client' | 'central' | 'sidecar' | 'system';
  sessionLeaseId?: string;
  payload: TPayload;
}
```

## 7. Session Query Payloads

### List Sessions

SDK publish event：

```json
{
  "eventId": "<uuid>",
  "sequence": 0,
  "type": "session.list.requested",
  "timestamp": "<iso timestamp>",
  "actor": "client",
  "ackId": "<ack-id>",
  "payload": {}
}
```

Central acknowledgement：

```json
{
  "eventId": "<uuid>",
  "sequence": 0,
  "type": "session.listed",
  "timestamp": "<iso timestamp>",
  "actor": "central",
  "ackId": "<same-ack-id>",
  "payload": {
    "sessions": [
      {
        "sessionId": "<session-id>",
        "status": "running",
        "resolvedAgentSpec": { "agentSpecId": "copilot-poc" },
        "owner": "<principal-id>",
        "eventCursor": 6,
        "createdAt": "<iso timestamp>",
        "updatedAt": "<iso timestamp>"
      }
    ]
  }
}
```

Browser apps must not maintain their own authoritative session list; local UI caches may only be display hints.

### Read Session Event History

SDK publish event：

```json
{
  "eventId": "<uuid>",
  "sessionId": "<session-id>",
  "sequence": 0,
  "type": "session.events.requested",
  "timestamp": "<iso timestamp>",
  "actor": "client",
  "ackId": "<ack-id>",
  "payload": {
    "afterSequence": 0
  }
}
```

Central acknowledgement：

```json
{
  "eventId": "<uuid>",
  "sessionId": "<session-id>",
  "sequence": 0,
  "type": "session.events.replayed",
  "timestamp": "<iso timestamp>",
  "actor": "central",
  "ackId": "<same-ack-id>",
  "payload": {
    "events": [
      { "type": "session.created", "sequence": 1 },
      { "type": "agent.output", "sequence": 2 }
    ]
  }
}
```

Central must enforce session ownership before replaying events.

When a leased worker is lost, central publishes `session.lease.lost` to the session events channel after persisting the failure, and publishes a lightweight session status/resource projection to `client-inbox`. If a turn was in flight and had not already produced `turn.completed` or `turn.failed`, central first publishes a `turn.failed` event for that turn with `error.code === 'worker_lost'`.

## 8. Session Command Payloads

### Start Session

SDK public input：

```ts
interface StartSessionInput {
  agent: string | {
    agentSpecId: string;
    version?: string;
  };
  input: SessionInput;
  displayName?: string;
  description?: string;
  externalId?: string;
  workspace?: { source: 'empty' };
  metadata?: { labels?: Record<string, string> };
}

interface SessionInput {
  message: string;
}
```

SDK publish event：

```json
{
  "eventId": "<uuid>",
  "sequence": 0,
  "type": "session.create.requested",
  "timestamp": "<iso timestamp>",
  "actor": "client",
  "ackId": "<ack-id>",
  "payload": {
    "agent": { "agentSpecId": "copilot-poc" },
    "input": { "message": "<message>" },
    "displayName": "<optional display name>",
    "description": "<optional description>",
    "externalId": "<optional app-owned id>",
    "workspace": { "source": "empty" }
  }
}
```

Central acknowledgement：

```json
{
  "eventId": "<uuid>",
  "sessionId": "<central-generated-session-id>",
  "turnSeq": 1,
  "sequence": 1,
  "type": "session.created",
  "timestamp": "<iso timestamp>",
  "actor": "central",
  "ackId": "<same-ack-id>",
  "payload": {
    "status": "queued"
  }
}
```

### Send Input

`session.send()` publish `input.received` 到 tenant inbox：

```json
{
  "eventId": "<uuid>",
  "sessionId": "<session-id>",
  "sequence": 0,
  "type": "input.received",
  "timestamp": "<iso timestamp>",
  "actor": "client",
  "ackId": "<ack-id>",
  "payload": {
    "input": { "message": "<message>" }
  }
}
```

Central acknowledgement：

```json
{
  "eventId": "<uuid>",
  "sessionId": "<session-id>",
  "turnSeq": 2,
  "sequence": 2,
  "type": "input.accepted",
  "timestamp": "<iso timestamp>",
  "actor": "central",
  "ackId": "<same-ack-id>",
  "payload": {
    "status": "accepted"
  }
}
```

## 9. Turn Events And Result

Agent-facing sidecar/runtime events stay persisted as runtime events. SDK maps the subset that belongs to a turn into app-facing `AgentTurnEvent` values. `agent.output` carries streaming deltas, tool/progress/approval events, and adapter diagnostics. Terminal turn state is not inferred from `agent.output`; sidecar must publish explicit `turn.completed` or `turn.failed` events with event envelope `turnSeq` matching the turn sequence, and central must persist and fan out those terminal events.

```ts
interface AgentOutputPayload {
  delta?: string;
  progress?: string;
  toolStarted?: { toolCallId: string; toolName: string; inputSummary?: unknown };
  toolCompleted?: { toolCallId: string; toolName: string; outputSummary?: unknown };
  approvalRequested?: unknown;
  internalEvent?: { type: string; data?: unknown };
  message?: string;
  output?: unknown;
  error?: { message: string; code?: string; details?: unknown };
}

interface TurnCompletedPayload {
  result: {
    message?: string;
    output?: unknown;
  };
}

interface TurnFailedPayload {
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

type AgentTurnEvent =
  | { type: 'turn.started'; sessionId: string; turnSeq: number }
  | { type: 'assistant.delta'; sessionId: string; turnSeq: number; text: string }
  | { type: 'agent.internal'; sessionId: string; turnSeq: number; label: string; detail?: unknown }
  | { type: 'agent.progress'; sessionId: string; turnSeq: number; message: string }
  | { type: 'tool.started'; sessionId: string; turnSeq: number; toolCallId: string; toolName: string; inputSummary?: unknown }
  | { type: 'tool.completed'; sessionId: string; turnSeq: number; toolCallId: string; toolName: string; outputSummary?: unknown }
  | { type: 'approval.requested'; sessionId: string; turnSeq: number; approval: unknown }
  | { type: 'turn.completed'; sessionId: string; turnSeq: number; result: AgentTurnResult }
  | { type: 'turn.failed'; sessionId: string; turnSeq: number; error: AgentTurnError };

interface AgentTurnResult {
  sessionId: string;
  turnSeq: number;
  message?: string;
  output?: unknown;
}
```

## 10. Slice 4 E2E Contract

Slice 4 e2e 从 SDK 开始：

1. Client SDK 使用 `centralUrl` 和 `tenantId` 调用 `/client/negotiate`。
2. Client SDK 建立 Web PubSub client connection。
3. Standalone sidecar 已注册 active ready Worker。
4. Client SDK 通过 `sessions.start()` 生成 `ackId`，publish `session.create.requested` 到 tenant inbox。
5. Central 写 session truth，生成 `sessionId` 和 initial `turnSeq = 1`，publish 带同一 `ackId` 的 `session.created` acknowledgement 到 client inbox，并 publish persisted `session.created` event 到 session events channel。
6. Central 选择 matching Worker 并写 `currentWorkerId`、`sessionLeaseId`。
7. Central publish `session.assign` 到 worker commands runtime channel。
8. Worker command subscriber 收到 `session.assign`。

E2E 必须使用真实 Web PubSub。缺少 `WEBPUBSUB_ENDPOINT` 时测试 skip；环境可用时该 e2e 是必跑验证项。

## 11. 同步规则

Public protocol 变化必须同步以下位置：

- 本文件。
- SDK public types 和 SDK implementation。
- Central public REST negotiate handler 和 runtime event handler。
- Sidecar public runtime event handler。
- Public protocol contract tests。
- SDK-to-central-to-worker e2e tests。

不允许只改 `src/` 后让 SDK 通过复制旧 shape 继续运行。SDK protocol drift 是 release blocker。