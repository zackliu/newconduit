# Agent Runtime Sidecar POC Spec

状态：POC 目标态  
读者：runtime owner、sidecar owner、SDK/API owner、POC implementer

## 1. 目的

这份 spec 定义第一个 POC 的最小实现边界。POC 要跑通从 AgentSpec 定义、session 创建、Docker worker 启动、Worker 注册、session 运行，到 pause/resume 的完整 workflow；暂不处理 Worker crash 后的自动 restore。

POC 的原则是：默认实现简单，但架构层次必须正确。也就是说，POC 固定使用一个 Copilot process-wrapper agent adapter、本地 file storage、Web PubSub transport、Docker worker、单 central instance；真实 agent smoke test 必须启动 GitHub Copilot SDK agent。Copilot 背后的模型来源通过显式 Copilot SDK provider config 指定；sidecar 只把配置传给 Copilot SDK，不直接调用 Azure OpenAI 或 OpenAI chat completions，也不根据 URL 猜测 provider 类型。AgentSpec、Session、Worker、Event、WorkspaceSnapshot、controller、adapter 的边界不能写错，也不能把 POC 的默认实现硬编码成未来资源模型。

## 2. POC 范围

POC 支持：

- 单 central service instance。
- Central 启动时按 multi-tenant 结构组织；POC 只创建一个预定义 tenant runtime：`poc`。
- Agent adapter 固定为 POC Copilot process-wrapper adapter；sidecar 启动 GitHub Copilot SDK agent，并可把显式 `COPILOT_PROVIDER_*` config 传给 Copilot SDK，但不直接调用模型 provider endpoint。
- Central 本地 file storage。
- Central 与 client 之间通过 Web PubSub 通信。
- Central 与 sidecar 之间通过 Web PubSub 通信。
- Worker 只考虑 Docker container。
- 一组预定义 `sidecarClass`、`workspaceClass`、`toolProfile`、`pausePolicy`、`recoveryPolicy`、`agentStatePolicy`，以及 session idle pause timeout，参数只保留 POC 运行必需项。
- 基于 Worker labels 的 `workerSelector`。
- Session create、run、pause、resume。
- Queued session scheduler 和 idle pause lifecycle：session status 与 client connection/subscription 独立，client open/history 不刷新 session activity，只有 create、input、resume、pause、agent/status output 等 session-scoped durable events 刷新 `lastEventUpdatedAt`。
- Docker workspace volume 和 agent session state volume 的 snapshot/restore。

POC 不支持：

- Worker crash 后自动 restore。
- 多 central instance。
- 非 Docker hosting adapter。
- 多 transport 实现。
- 独立 output resource。
- 完整 auth/action matrix。
- 多 tenant 生产隔离。
- managed service。

## 3. 默认实现选择

| 架构位置 | POC 默认实现 | 不能被默认实现改变的边界 |
| --- | --- | --- |
| Central storage | Central 进程本地目录下的 JSONL/JSON 文件 | Session、Worker、Event、WorkspaceSnapshot 仍然是独立 facts。 |
| Client transport | Web PubSub client connection | Client 不直接连接 Worker。 |
| Sidecar transport | Web PubSub client connection | Sidecar connection 是 runtime/deployment 级配置，不进入 AgentSpec。 |
| Web PubSub usage pattern | PubSub client connections + group pubsub | Web PubSub 只作为打通网络的长连接通道；session truth 仍由 central 写入。 |
| Hosting adapter | Docker adapter | Docker container 不是 Worker identity；sidecar 注册后才形成 Worker。 |
| Docker volume snapshot storage | Central 本地 snapshot 目录 | Worker 上的 workspace 和 agent-owned session state 分别在 Docker volumes 中；pause/resume 时由 Docker volume adapter 复制，central 不解释 agent session 文件格式。 |
| Copilot agent provider config | GitHub Copilot SDK `provider` config | sidecar 接受显式 `COPILOT_MODEL`、`COPILOT_PROVIDER_TYPE` 和 `COPILOT_PROVIDER_BASE_URL`。sidecar 用 Azure Identity/MSI 获取 provider bearer token，再传给 Copilot SDK session config；模型调用由 Copilot SDK/agent 执行，sidecar 不拼接 provider endpoint、不发 chat completion HTTP request。 |

Web PubSub 的 POC 形态是：central、client、sidecar 都作为 Web PubSub clients 连接。Web PubSub 不启用 upstream，不要求 central 暴露公网 callback endpoint，也不把 Web PubSub 当作业务处理方。它只提供一条能跨网络保持的长连接；central 收到事件后写本地 storage，再通过自己的 Web PubSub client connection 把结果发到 session events 和 worker commands runtime channels。

## 4. Web PubSub 映射

POC 使用 hub `agentruntimepoc`。

| Runtime 概念 | Web PubSub 映射 |
| --- | --- |
| Central runtime connection | Web PubSub client connection，由 central 自己通过服务端配置获取 token。 |
| Client connection | Web PubSub client connection，由 central `/client/negotiate` 颁发 token。 |
| Sidecar connection | Web PubSub client connection，由 central `/sidecar/negotiate` 颁发 token。 |
| Tenant inbox runtime channel | Web PubSub group `tenant:{tenantId}:central:events`，client/sidecar 的 runtime events 先发到这里。 |
| Client inbox runtime channel | Web PubSub group `tenant:{tenantId}:clients`，POC 中 tenant 内 client 都可订阅；只承载 session 本体状态和 catalog 投影，不承载 request-specific ack/response，也不承载大体量 session 内容流。 |
| Client private inbox runtime channel | Web PubSub group `tenant:{tenantId}:client:{clientConnectionId}:inbox`，SDK/client 启动时生成随机 `clientConnectionId` 并在 `/client/negotiate` 传给 central；只承载当前 SDK connection 的 request ack 和 query response。 |
| Session events runtime channel | Web PubSub group `tenant:{tenantId}:session:{sessionId}`。 |
| Worker commands runtime channel | Web PubSub group `tenant:{tenantId}:worker:{workerId}`。 |
| Client writes | client publish 到 tenant inbox runtime channel，payload 中包含 session/action/correlation 信息。 |
| Sidecar writes | sidecar publish 到 tenant inbox runtime channel，payload 中包含 worker/session/session lease 信息。 |
| Central fan-out | central 作为 Web PubSub client publish 到 client inbox、client private inbox、session events 和 worker commands runtime channels。 |

Web PubSub group name 是 adapter-internal 映射，不进入 shared runtime contract。Shared contract 暴露 `tenant-inbox`、`client-inbox`、`client-private-inbox`、`session-events`、`worker-commands` 这类 runtime channels。Group membership 和 roles 由 central 在 negotiate 时基于 runtime channels 生成；POC 当前不展开最小权限矩阵。

Client-facing source of truth 必须分清：`client-private-inbox` 只解决 request correlation；`client-inbox` 只解决 tenant-wide session resource projection；`session-events` 才是 session content 和 persisted history 的 source of truth。Central 不把同一个 full session event 同时发到 `client-inbox` 和 `session-events`。如果同一个 durable fact 同时需要 ack 和 session history，ack 必须使用独立 event type 和轻量 payload，例如 `session.created.ack` 或 `input.accepted.ack`。

POC 的 `/negotiate` 仍然是 central-owned boundary。当前 demo route 在 HTTP 入口层构造 demo `RequestContext`，Web PubSub adapter 把 principal 编入 token `userId`，tenant runtime 收到消息时从 transport envelope 取得 per-message context。Create session payload 不携带 `tenantId`、`principal`、`owner`。

Sidecar bootstrap 由 `/sidecar/negotiate` 完成。Sidecar 启动时通过 JSON body 显式提交 `sidecarClass`、labels、capacity、allocatable 和可选 description；central 在该 HTTP boundary 里认证/授权、创建 WorkerRecord、写 central-authored `worker.registered` lifecycle event，并返回 Web PubSub access URL 与 central 分配的 `workerId`。Sidecar 连接后只需要 join `worker-commands:{workerId}`，再通过 tenant inbox publish heartbeat 和 agent/session events。POC 不保留 Web PubSub `worker.register` request 或 `worker.registered` ack 路径。

## 5. 本地 File Storage

Central storage 使用本地 tenant data root `.runtime-poc/tenants/poc/`。

```text
.runtime-poc/tenants/poc/
  agentspecs/
    <agentSpecId>.json
  sessions/
    <sessionId>/
      session.json
      events.jsonl
      snapshots/
        <snapshotId>/
          snapshot.json
          volumes/
            workspace/
            copilot-session/
  workers/
    <workerId>.json
  audit/
    audit.jsonl
```

POC 不引入数据库，但文件写入要保留清晰 ownership：

- Session lifecycle controller 写 `session.json` 和 lifecycle events。
- Event log controller append `events.jsonl`。
- Worker registry controller 写 `workers/<workerId>.json`。
- Snapshot controller 写 `snapshot.json`，并通过 Docker volume adapter 把 workspace volume 和 agent session state volume 保存到同一个 snapshot boundary 下。
- Audit controller append `audit.jsonl`，具体 action matrix 后续定义。

POC 使用单 central 进程串行写，暂不处理多 central 并发。

## 6. Worker 和 Sidecar

POC 的 Worker 就是 sidecar 运行实体通过 `/sidecar/negotiate` 注册进 central 后形成的 runtime capacity。`workerId` 是这个运行实体在 runtime 内的唯一 identity。hostname、pod name、container id、machine name 只作为 labels 或 diagnostic metadata，不参与 runtime identity。Standalone sidecar 可以直接注册，Docker WorkerPool provision 出的 sidecar 也必须通过同一个 `/sidecar/negotiate` registration contract 注册。

Sidecar negotiate 只创建 registered worker fact。Worker 必须随后发送首个 `worker.heartbeat`，central 收到首个 heartbeat 后才把它放入 active ready selection path。注册后如果没有持续 heartbeat，central 的周期性 Worker lifecycle reconciler 根据 `expiresAt` 执行 evacuation，并把该 Worker 从 active registry 移除。Central restart 后不会从本地 worker 文件自动恢复 active Worker；仍然活着的 sidecar/worker 必须重新调用 `/sidecar/negotiate` 形成新的 Worker lifetime，并重新 heartbeat。

Active worker registry 和 historical worker record 是两个视图。Closed、expired、evacuated、drained 的 Worker 必须从 active registry 消失，selection 永远不能返回它们；storage 可以保留 terminal record 和 worker events 作为 debug/audit history。Terminal Worker 不能被迟到 heartbeat 复活。Worker 再次出现时必须重新 register 成新的 Worker lifetime。

Worker 最小 registration payload：

| 字段 | POC 含义 |
| --- | --- |
| `workerId` | Worker runtime identity。POC 可以由 central 在 register 时分配；一旦 Worker terminal，后续重连必须获得新的 `workerId`。 |
| `sidecarClass` | POC 预定义 `process-wrapper`。 |
| `labels` | 任意 key/value，用于 `workerSelector`。 |
| `capacity` / `allocatable` | 固定为 1。 |
| `conditions` | ready、busy、draining、disconnected。 |
| `heartbeatAt` | sidecar 定期上报。 |
| `expiresAt` | central 根据 keepalive TTL 计算。 |
| `description` | 可选 diagnostic metadata，例如 hostname、pod name、container id。 |

Worker selection 只使用 active registry 中 ready、未过期、allocatable 大于 0、`sidecarClass` 匹配、labels 匹配的 Worker。POC 不增加新的 selector 字段，不增加复杂匹配模型。

Worker lifecycle 和 Session lifecycle 是两条独立状态机。Worker 只表示可替换 compute；Session 是 durable workload identity。二者之间的桥是 session lease。Central 给 session 分配 Worker 时写入当前 `workerId` 和 `sessionLeaseId`。Sidecar 对该 session 写 output/status/snapshot/turn terminal event 时必须带当前 `sessionLeaseId`；central 只接受当前 lease，拒绝旧 lease 或未知 lease 的写入。

Drain 和 evacuate 是两个不同流程：

| 流程 | 触发 | Central 行为 | Worker 交互 |
| --- | --- | --- | --- |
| Drain | Worker 仍可通信，operator 或 sidecar 主动请求退出。 | Worker 进入 `draining`，不再接新 session；central 尝试把该 Worker 上的 session lease 迁移到其他 active 且 label 匹配的 Worker。POC 若不能恢复该 session，则按 session policy 默认 failed。所有 session 离开后 central 发送 `worker.close.requested`。 | Worker 收到 close 后 graceful 停止 agent/sidecar 进程并停止 heartbeat。 |
| Evacuate | Worker heartbeat timeout、central restart 后旧 Worker 未重新注册、或 worker connection loss。 | Central 不能假设还能与该 Worker 通信；它使相关 session lease lost，并按 session policy 默认 failed。Worker 从 active registry 移除。 | 不要求 dead worker ack；迟到 heartbeat rejected。 |

Close 是 terminal：central 已经决定关闭的 Worker 不再 active，不再可选，后续 heartbeat rejected。Close 可以保留 terminal record/history，但 active registry 里不存在该 Worker。

## 7. POC Workflow

### 7.1 Register AgentSpec

POC 使用一个静态 AgentSpec JSON 文件。AgentSpec 包含：

- `agentSpecId`
- `launch`
- `labels`
- `sidecarClass`
- `workspaceClass`
- `toolProfile`
- `workerSelector`
- `pausePolicy`
- `recoveryPolicy`
- `agentStatePolicy`
- `idlePauseTimeoutMs`

POC 使用预定义 class/profile，而不是把所有值都叫 `default`。这些值应该表达 POC 的真实实现选择，参数保持最小：

| 字段 | POC 预定义值 | 含义 |
| --- | --- | --- |
| `sidecarClass` | `copilot-process-wrapper` | sidecar 以 process wrapper 方式启动 POC agent adapter。 |
| `workspaceClass` | `docker-workspace-volume-snapshot` | workspace 是 Docker volume；pause 时由 sidecar workspace adapter capture 到 central 的 session-addressed snapshot 区，resume 时 restore 回新 Worker。 |
| `toolProfile` | `copilot-poc-tools` | 只装配 Copilot POC 需要的最小工具集合。 |
| `pausePolicy` | `turn-boundary-durable-pause` | pause 在 turn/checkpoint 边界完成，snapshot 后释放 worker lease。 |
| `recoveryPolicy` | `restart-with-context` | POC 默认 resume 模式是恢复 workspace/event context 后重启 agent。 |
| `agentStatePolicy` | `copilot-session-volume-snapshot` | capture/restore agent session state 目录；agent-owned session history 保留在 adapter 自己的 session 文件里，resume 时 Copilot 用 `resumeSession()` 续接。 |
| `idlePauseTimeoutMs` | `120000` | session 在没有 session-scoped durable event 更新后进入 idle pause 的超时时间。该窗口要足够长，让 queued session 等到 Worker scale-out 完成。 |

这些 class/profile 在 POC 中由静态 registry 文件定义；它们仍然作为 AgentSpec 字段出现，避免 controller 直接硬编码实现细节。

### 7.2 Create Session

Create session 的语义是 client 请求当前 tenant runtime 创建 durable session。POC 的传输实现固定为：client publish `session.create.requested` 到 tenant inbox runtime channel；Web PubSub adapter 把该 channel 映射为 `tenant:poc:central:events` group。Payload 只描述要创建什么 session，不自报 tenant 或 principal：`agent.agentSpecId`、`input.initialMessage`、`input.clientRequestId`、`workspace.source`。Tenant runtime 从 transport envelope 得到 principal context，从 tenant runtime 配置得到 tenant `poc`，然后创建 `session.json`，再 append `session.created` 和 initial input event。

如果没有 ready Worker，session 进入 `queued`。Tenant runtime 的 session lifecycle reconciler 会在 `lastEventUpdatedAt` 仍处于 AgentSpec `idlePauseTimeoutMs` 窗口内时持续尝试 assignment。Worker capacity scaler 只负责在没有 matching ready Worker 时 provision matching Worker capacity，不直接改变 session status 或绕过 Worker registration/selection contract。

### 7.3 Register Worker

Sidecar container 调用 `/sidecar/negotiate`，在 HTTP body 中提交 sidecarClass、labels、capacity、allocatable 和可选 description。Central 写 registered Worker record，并在 negotiate response 中返回 central 分配的 `workerId` 和 Web PubSub access URL。Sidecar 连接 Web PubSub 后订阅 `worker-commands:{workerId}`，随后开始周期性发送 `worker.heartbeat`。Central 收到首个 heartbeat 后才把该 Worker 放入 active ready selection path，并立即运行一次 session lifecycle reconciler。Reconciler 找到 eligible queued session 后，Session lease controller 写入 `currentWorkerId` 和新的 `sessionLeaseId`，并把 session 推进到 `starting`。

Central publish `session.assign` 到 worker commands runtime channel；Web PubSub adapter 映射为 `tenant:poc:worker:{workerId}` group。Assignment payload 包含 `sessionId`、`workerId`、`sessionLeaseId`、workspace ref、agent session state ref、resolved AgentSpec 和 runtime config。Sidecar 收到后挂载 workspace volume 和 agent session state volume，并按 AgentSpec launch 启动 Copilot process adapter。POC 的 sidecar 通过 GitHub Copilot SDK 启动 agent session；如果配置了 `COPILOT_PROVIDER_*`，sidecar 只把这些值原样映射为 Copilot SDK provider config，不直接获取 provider token 或调用 provider HTTP API。

### 7.4 Run Session

Client input 通过 Web PubSub publish 到 tenant inbox runtime channel。Central 的 Web PubSub client connection 收到后 append input event，再 publish 到当前 `sessionLeaseId` 对应的 worker commands runtime channel。Sidecar 若收到 input 早于 agent ready，必须在该 session lease 内等待 agent ready，而不是把 input 当作 unknown session 拒绝。Sidecar 转给 agent process adapter。

Agent output、tool event、status event 由 sidecar publish 到 tenant inbox runtime channel，并携带当前 `sessionLeaseId`。Central 校验 lease 后 append event，再 publish 到 session events runtime channel。Turn terminal state 使用显式 `turn.completed` / `turn.failed` runtime events；SDK 不从普通 `agent.output` 推断 turn 结束。Client 从 session events channel 接收 stream。

### 7.5 Pause Session

Pause session 的语义是 client 请求 central 把 running session 带到 durable pause boundary。POC 的传输实现固定为：client publish `session.pause.requested` 到 tenant inbox runtime channel。Central append `pause.requested`，把 session 状态改为 `pausing`，分配 `snapshotId` 与 session-addressed snapshot location，并把带 capture ref 的 pause command publish 到 worker commands runtime channel。

Idle pause 使用同一个 durable pause boundary 与同一个 capture 机制。Session lifecycle reconciler 发现 running session 的 `now - lastEventUpdatedAt >= idlePauseTimeoutMs` 后，central append reason 为 `idle_timeout` 的 `session.pause.requested`，把 session 状态改为 `pausing`，并 publish 带 capture ref 的 pause command 到当前 Worker。Client connect、open、list、history replay 和 attach session events 不算 activity，不会阻止 idle pause。

Sidecar 根据 `pausePolicy` 到达 safe boundary：停止接收新 input，flush output，stop agent process adapter 让 agent session state 文件落盘一致，再调用 workspace adapter capture，把 workspace 与 agent session state 复制进 capture ref 指定的 snapshot location 的 parts。Sidecar 把它捕获的 `snapshotId` 与 parts 放进 `session.paused` 一起 publish。

Central 收到 `session.paused` 后写 `WorkspaceSnapshot` record（`baseEventCursor` 对齐 pause event boundary），append `snapshot.created` marker，更新 `latestSnapshotRef`，释放当前 worker lease，把 session 状态改为 `paused`。Snapshot 按 `sessionId` 归档在 central data root 的 `snapshots/<sessionId>/<snapshotId>/`，与写入它的 Worker 实例无关，因此 Worker 回收后仍可凭 session 身份找回。POC 默认 durable pause，不保留 parked continuation。

### 7.6 Resume Session

Resume session 的语义是 client 请求 central 从 paused session 恢复执行投影。POC 的传输实现固定为：client publish `session.resume.requested` 到 tenant inbox runtime channel。Central 读取 session、`latestSnapshotRef` 指向的 snapshot record、resolved AgentSpec、pausePolicy、agentStatePolicy 和 recoveryPolicy。POC 不处理 crash recovery，但 resume 仍然走 planned restore path。

Central append `session.resume.requested`，刷新 `lastEventUpdatedAt`，并把 paused session 放回 `queued`。Resume 本身是 session activity，因此刚 resume 的 session 不会在同一轮 reconciler 中被 idle pause。Session lifecycle reconciler 使用与普通 queued session 相同的 assignment path 选择 ready Worker；没有 ready Worker 时，Worker capacity scaler 调用 Docker adapter 启动一个 sidecar container。Assignment 写新的 `sessionLeaseId`，assign command 携带从 `latestSnapshotRef` 解析出的 restore ref（`snapshotId`、snapshot location、parts）。

新 Worker 的 sidecar 收到带 restore ref 的 assign 后，先调用 workspace adapter restore 把 snapshot parts 复制回新 Worker 的 workspace 与 agent session state 卷，再启动 agent process adapter。Copilot process adapter 启动后用 `getLastSessionId()` 发现恢复出来的 Copilot session 并 `resumeSession()` 续接，没有已存在 session 时才 `createSession()`。

恢复模式：

| 模式 | POC 行为 |
| --- | --- |
| True continuation | POC 不使用。 |
| Restart with context | POC 固定模式：restore workspace、event history 和 agent session state 后重启并续接 agent session。 |
| Non-recoverable failure | snapshot record 缺失、agent session state part 缺失时进入 failed。 |

Resume 成功后，sidecar 报 `status.changed running`，central 把 session 从 `starting` 推进到 `running`。Client open/history 只读取 paused session 的 history/status，不会隐式 resume。

## 8. Controllers 和 Adapters

| Controller / adapter | POC 默认职责 |
| --- | --- |
| AgentSpec admission controller | 读取静态 AgentSpec，解析 POC 预定义 class/profile。 |
| Session lifecycle controller | create、queued、starting、running、pausing、paused、failed；resume command 先把 paused session 放回 queued。 |
| Session lifecycle reconciler | 周期性扫描 queued/running session；eligible queued session 进入 assignment workflow，idle queued session 进入 paused，idle running session 进入 pause boundary 并释放 worker lease。Worker ready heartbeat 后立即运行同一个 reconciler 一次。 |
| Worker registry controller | 接收 worker registration 和 heartbeat，维护 active worker registry 与 historical worker record。 |
| Worker lifecycle reconciler | 周期性检查 heartbeat expiry；对失联 Worker 执行 evacuation，从 active registry 移除 Worker，并让受影响 session lease lost。 |
| Worker drain controller | 对仍可通信的 Worker 执行 drain：停止新分配、迁移/失败当前 session lease、发送 close command，并在完成后从 active registry 移除 Worker。 |
| Worker selection controller | 只从 active registry 中选择 ready、未过期、allocatable、label 匹配的 Worker。 |
| Session lease controller | 写 `currentWorkerId`、`sessionLeaseId`，并用 `sessionLeaseId` 拒绝旧 sidecar 写入。 |
| Event log controller | append/replay 本地 `events.jsonl`。 |
| Snapshot manager | 分配 snapshot id 与 session-addressed location，在 pause command 上附带 capture ref，在 assign 上附带 restore ref，并在收到 `session.paused` 后写 `WorkspaceSnapshot` record、append `snapshot.created` marker、更新 `latestSnapshotRef`。不读 Worker 活动卷字节。 |
| Worker capacity scaler | POC 中直接调用 Docker adapter 启动一个 container。 |
| Web PubSub transport adapter | 统一处理 central/client/sidecar client connection、negotiate、runtime channel 到 tenant-prefixed Web PubSub group 的映射，以及 group publish。 |
| Docker WorkerPool controller/adaptor | provision sidecar container；container 内 sidecar 仍走同一个 Worker registration contract。 |
| Docker volume adapter | 在 Snapshot controller 调用下复制和恢复 workspace volume、agent session state volume。 |
| Sidecar agent adapter | POC Copilot process-wrapper agent adapter；通过 GitHub Copilot SDK 启动 agent session，不直接调用 Azure OpenAI/OpenAI chat completions。 |
| Sidecar workspace adapter | 挂载 Docker workspace volume 和 agent session state volume。 |
| Workspace storage adapter | central 本地 snapshot file copy。 |

## 9. 验证标准

POC 完成时，至少能演示：

1. 加载 POC 静态 AgentSpec 和预定义 class/profile registry。
2. Client 通过 Web PubSub 连接 central。
3. Central 通过 Docker adapter 启动 sidecar container。
4. Sidecar 通过 Web PubSub 注册 Worker。
5. 创建 session 后，central 写本地 session file 和 event log。
6. Client input 经 central append event 后路由到 sidecar。
7. Agent output 经 central append event 后推送给 client。
8. Queued session 在 matching Worker ready 后由 session lifecycle reconciler assignment；client 不需要保持连接。
9. Idle queued/running session 按 AgentSpec `idlePauseTimeoutMs` 进入 `paused`；client open/history 不刷新 activity，也不会隐式 resume。
10. Pause 后生成 workspace volume snapshot 和 agent session state volume snapshot，session 进入 `paused`。
11. Resume 后刷新 session activity，把 session 放回 `queued`，恢复 workspace volume 和 agent session state volume，agent adapter 启动，session 回到 `running`。
12. Client 断线重连后通过 event cursor replay 已有 events。

## 10. 后续不在 POC 内

- Worker crash detection 和自动 restore。
- 多 central instance 和 shared database。
- Kubernetes/VM hosting adapter。
- 生产级 auth/action matrix。
- Web PubSub 以外的 transport 实现。
- 独立 output resource。
- 复杂 WorkerPool、quota、reservation、rollout。