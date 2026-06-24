# Agent Runtime Sidecar SDK Public Protocol Spec

状态：SDK public protocol spec  
读者：SDK implementer、runtime owner、sidecar owner、e2e test owner

## 1. 边界

SDK 是客户侧代码，目录固定在 `sdk/`。`src/` 是服务提供商 runtime implementation。SDK 不 import `src/`，不 import `src/shared`，不复用 central、sidecar、storage、controller、adapter implementation code。

SDK 与 runtime 的共享点是 public protocol，不是代码共享。Public protocol 以本文件为 SDK 侧 source of truth。Central、sidecar、SDK、e2e tests 修改 public protocol 时必须同步本文件。

## 2. POC 传输形态

SDK POC 只使用两类交互：

1. REST 到 central：只用于 negotiate Web PubSub client access URL。
2. Web PubSub client connection：用于所有 session command 和 turn event 交互。

Session create、input、pause、resume、cancel 都必须走 Web PubSub tenant inbox。SDK 和 central 不提供第二条 HTTP session command 路径。SDK 不直接连接 Worker endpoint。SDK 不读取 Worker address、Docker container、WorkerPool source、sidecar process state。

Central 的实现分层必须保持清晰：处理 Web PubSub runtime event、REST negotiate、未来 gRPC/queue 等入口协议的类称为 Controller，代表可替换的协议边界；维护 session lifecycle、turn sequence、assignment、event log、worker registry/lease 等 tenant 内部流程和状态机制的类称为 Manager。`TenantRuntime` 只作为 tenant-scoped composition root 和 ingress shell，负责组装 controllers/managers 并把 transport ingress 委托出去，不直接承载每条 session command workflow。

## 3. REST Endpoint

### Client Negotiate

```text
POST /client/negotiate?tenantId=<tenantId>
```

Request body：POC 为空。

Response body：

```json
{
  "url": "<web-pubsub-client-access-url>",
  "clientInbox": {
    "principalId": "<authenticated-principal-id>"
  }
}
```

SDK 行为：

- SDK 使用 caller 提供的 `centralUrl` 和 `tenantId` 组装 negotiate URL。
- SDK 不把 principal、owner、role 写入 create session payload。
- SDK 将 response `url` 交给 Web PubSub client。
- SDK 建立 Web PubSub connection 后必须 join `clientInbox` 对应的 runtime channel，用于接收 command acknowledgement。

## 4. Runtime Channels

SDK 使用 runtime channel 概念，不把 Web PubSub group name 暴露给 SDK public API。

| Runtime channel | SDK 用途 | Web PubSub group 映射 |
| --- | --- | --- |
| tenant inbox | publish session create/input/pause/resume/cancel request events | `tenant:{tenantId}:central:events` |
| client inbox | receive command acknowledgements for the authenticated client principal | `tenant:{tenantId}:client:{principalId}:events` |
| session events | receive persisted session and turn events | `tenant:{tenantId}:session:{sessionId}` |

Worker commands channel 不属于 SDK public API。

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
  close(): Promise<void>;
}

class SessionClient {
  start(input: StartSessionInput): Promise<StartSessionResult>;
  open(sessionId: string): Promise<SessionHandle>;
}

interface StartSessionResult {
  session: SessionHandle;
  turn: AgentTurn;
}

class SessionHandle {
  readonly id: string;

  send(input: SessionInput): Promise<AgentTurn>;

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

`connect()` 调用 central negotiate 并建立 Web PubSub client connection。`sessions.start()` 可以 lazy connect；它由 SDK 生成 `ackId`，publish `session.create.requested` 到 tenant inbox，然后等待 client inbox 上带同一 `ackId` 的 `session.created` acknowledgement。Central 生成 durable `sessionId`，并为 initial input 分配 session-scoped `turnSeq = 1`。SDK 收到 acknowledgement 后返回 `StartSessionResult`。

`ackId` 只用于 command request/ack correlation，由 SDK 生成。`sessionId` 是 central-owned durable session identity，client 不能指定。`turnSeq` 是 central-owned、session-scoped、单调递增的 turn identity，用来表达这个 session 中第几轮 agent work。Client 可以设置 `displayName`、`description`、`externalId` 或 `metadata.labels` 这类业务展示/关联字段，但不能设置 runtime identity。

`sessions.open(sessionId)` 只返回现有 durable session 的本地 handle，不改变 session lifecycle。`session.resume()` 才是 runtime lifecycle command，会 publish `session.resume.requested`。

`session.send()` 生成 `ackId`，publish `input.received` 到 tenant inbox，并等待 client inbox 上带同一 `ackId` 的 `input.accepted` acknowledgement。Central 为该 input 分配下一个 `turnSeq`，SDK 收到 acknowledgement 后返回对应 `AgentTurn`。`turn.events()` 订阅该 session 的 persisted events 并按 `turnSeq` 过滤、映射为 app-facing turn events。`turn.waitForResult()` 消费同一组 turn events，等待该 turn 的最终 result 或 failed event。

## 6. Session Command Payloads

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
  workspace?: {
    source: 'empty';
  };
  metadata?: {
    labels?: Record<string, string>;
  };
}

interface SessionInput {
  message: string;
}
```

SDK publish event：

```ts
type SdkRuntimeEventType =
  | 'session.create.requested'
  | 'input.accepted'
  | 'input.received'
  | 'agent.output'
  | 'session.pause.requested'
  | 'session.resume.requested'
  | 'session.cancel.requested'
  | 'session.created'
  | 'session.assign'
  | 'session.paused'
  | 'session.resumed'
  | 'session.cancelled';

interface CreateSessionInput {
  agent: {
    agentSpecId: string;
    version?: string;
  };
  input: SessionInput;
  displayName?: string;
  description?: string;
  externalId?: string;
  workspace: {
    source: 'empty';
  };
  metadata?: {
    labels?: Record<string, string>;
  };
}
```

Runtime event envelope：

```ts
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
  workerLeaseGeneration?: number;
  payload: TPayload;
}
```

Create session event：

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

Central create acknowledgement：

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

Central input acknowledgement：

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

### Turn Events And Result

Agent-facing sidecar/runtime events stay persisted as runtime events. SDK maps the subset that belongs to a turn into app-facing `AgentTurnEvent` values. The default turn result event for POC is `agent.output` with event envelope `turnSeq` matching the turn sequence.

```ts
type AgentTurnEvent =
  | { type: 'turn.started'; sessionId: string; turnSeq: number }
  | { type: 'assistant.delta'; sessionId: string; turnSeq: number; text: string }
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

## 7. Slice 4 E2E Contract

Slice 4 e2e 从 SDK 开始：

1. Client SDK 使用 `centralUrl` 和 `tenantId` 调用 `/client/negotiate`。
2. Client SDK 建立 Web PubSub client connection。
3. Standalone sidecar 已注册 active ready Worker。
4. Client SDK 通过 `sessions.start()` 生成 `ackId`，publish `session.create.requested` 到 tenant inbox。
5. Central 写 session truth，生成 `sessionId` 和 initial `turnSeq = 1`，publish 带同一 `ackId` 的 `session.created` acknowledgement 到 client inbox，并 publish persisted `session.created` event 到 session events channel。
6. Central 选择 matching Worker 并写 `currentWorkerId`、`workerLeaseGeneration`。
7. Central publish `session.assign` 到 worker commands runtime channel。
8. Worker command subscriber 收到 `session.assign`。

E2E 必须使用真实 Web PubSub。缺少 `WEBPUBSUB_ENDPOINT` 时测试 skip；环境可用时该 e2e 是必跑验证项。

## 8. 同步规则

Public protocol 变化必须同步以下位置：

- 本文件。
- SDK public types 和 SDK implementation。
- Central public REST handler 和 runtime event handler。
- Sidecar public runtime event handler。
- Public protocol contract tests。
- SDK-to-central-to-worker e2e tests。

不允许只改 `src/` 后让 SDK 通过复制旧 shape 继续运行。SDK protocol drift 是 release blocker。