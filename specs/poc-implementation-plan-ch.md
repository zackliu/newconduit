# Agent Runtime Sidecar POC Implementation Plan

状态：实现计划  
读者：POC implementer、runtime owner、sidecar owner、reviewer

## 1. 目的

这份文档把 [poc-runtime-workflow-spec-ch.md](poc-runtime-workflow-spec-ch.md) 拆成可实现、可测试、可 review 的 coding slices。它不按源码目录排序，而按 POC workflow 的业务可观察结果排序。

每个 slice 都必须有 scenario-based test。测试要证明 runtime 行为，而不是证明某个 private helper 被调用。

## 2. 实现原则

1. 先做 public contract，再做默认实现。
2. 先写 central-owned truth，再做 fan-out；sidecar command 必须在 central-owned truth 写入后发布。
3. Web PubSub 只作为长连接 transport；session truth 不在 Web PubSub。
4. Tenant 是 high-level runtime boundary。POC 只有一个 `poc` tenant runtime，但 `tenantId` 不由 create session payload 自报。
5. Principal 来自 negotiate/connection context；runtime message ingress 使用 transport envelope 中的同一 RequestContext。Create session payload 不自报 `principal`、`owner`。
6. SDK 是客户侧代码，放在 `sdk/client/`，不 import `src/`。`src/` 是服务提供商 runtime implementation；SDK 只按 `sdk/client/public-protocol-spec-ch.md` 实现 public protocol。
7. Public protocol 变化必须同步更新 `sdk/client/public-protocol-spec-ch.md`、SDK 类型、central/sidecar public protocol 处理、e2e tests。
8. Worker 是注册进 tenant runtime 的可用 capacity。实现计划先用 standalone sidecar direct registration 验证 Worker lifecycle contract，再接入 POC 的 Docker WorkerPool scale loop；注册成功后都进入同一套 Worker registry contract。Standalone path 是验证 wedge，不是新的 hosting model。
9. WorkerPool 是 tenant-scoped capacity configuration，不是 Worker。它声明可 scale 出来的 Worker labels、`hostPoolControllerClass`、scale policy，并由 WorkerPool controller 调用对应 hostPoolAdapter 操作具体 host。
10. Worker selection 只使用 AgentSpec selector 与 Worker record 上的 `sidecarClass`、labels、capacity、conditions；不按 standalone、Docker、WorkerPool source 分叉。
11. Worker registry 必须区分 active Worker 和历史/tombstone record。只有 active、ready、allocatable 的 Worker 能被 selection；closed、expired、disconnected、draining 且无可分配容量的 Worker 都不能被分配新 session。
12. 先跑通 standalone sidecar worker、Client SDK create session、assignment、Copilot process-wrapper、多轮 session event loop、queued session scheduler 和 idle pause policy，再接入 WorkerPool scale loop。
13. Agent session history 由具体 agent adapter 自己的 state files 承载；POC 通过 sidecar-managed agent session state directory/volume 验证 process-wrapper 行为，通过 Docker volume snapshot/restore 保留这些文件。Event cursor、event log 和 snapshot marker 仍由 central-owned storage 表达，sidecar-local metadata 不作为 session truth。
14. 每个 slice 的测试都用 scenario 名字描述系统结果。
15. 不为 POC 添加 crash recovery、Kubernetes、完整 auth matrix、非 Web PubSub transport。
16. Session lifecycle status 与 client connection/subscription 独立。Client connect、open、list、history replay 和 attach session events 不刷新 session activity，也不改变 session status；只有 create、input、resume、pause、agent/status output 等 session-scoped durable events 才刷新 session 的 `lastEventUpdatedAt`。

## 3. Slice 1：Durable Session Truth

目标：Central 能把一次 create session request 保存成可重启后读取的 session record 和 event log。

实现范围：

- `AgentSpec`、`SessionRecord`、`RuntimeEvent` model。
- POC 静态 AgentSpec 和预定义 class/profile registry。
- Central local file storage。
- Event log append/replay。
- Session lifecycle create/queued 状态。

Scenario-based test：`scenario: create session request creates durable session truth`

Given：

- POC 静态 AgentSpec 已加载。
- Runtime test publisher publish `session.create.requested` 到 tenant inbox runtime channel；客户侧入口从 Slice 4 的 Client SDK 开始。
- Payload 包含 `agent.agentSpecId`、`input.message`、`workspace.source`，event envelope 可包含用于 command acknowledgement 的 `ackId`。
- Payload 不包含 `tenantId`、`principal`、`owner`。

Expect：

- Central 写入 `sessions/<sessionId>/session.json`。
- `session.json` 包含 resolved AgentSpec。
- `session.json` 的 tenant 来自 POC tenant runtime：`poc`。
- `session.json` 的 owner 来自 demo principal context。
- Central append `session.created` event 到 `events.jsonl`。
- Session status 是 `queued`；后续 assignment slice 再把它推进到 `starting`。
- Event cursor 反映已写入事件。

## 4. Slice 2：Web PubSub Client-Connection Transport

目标：Client、sidecar、central 都能通过 Web PubSub client connection 交换 runtime events，且所有改变 truth 的 event 先到 central。

实现范围：

- `/client/negotiate` 和 `/sidecar/negotiate` 的 central-owned token boundary。
- Central runtime Web PubSub client connection。
- Runtime channels：`tenant-inbox`、`session-events`、`worker-commands`。
- Web PubSub adapter 内部把 runtime channels 映射为 tenant-prefixed groups：`tenant:{tenantId}:central:events`、`tenant:{tenantId}:session:{sessionId}`、`tenant:{tenantId}:worker:{workerId}`。
- In-memory runtime transport adapter 用于测试。

Scenario-based test：`scenario: real Web PubSub client event reaches tenant inbox channel`

Given：

- Runtime test publisher 持有 central negotiate 返回的 token。
- Web PubSub adapter 使用 tenant-prefixed group 映射。
- 本 slice 不展开 token 最小权限矩阵。

Expect：

- Runtime test publisher publish `session.create.requested` 到 tenant inbox runtime channel 对应的 Web PubSub group；客户侧入口从 Slice 4 的 Client SDK 开始。
- Central runtime connection 收到该 event，并把 `fromUserId` 还原为 transport envelope 中的 principal context。
- Tenant runtime 能从 tenant inbox 处理该 event；local truth 写入由 Slice 1 的 durable session scenario 覆盖。
- Test 不使用 Web PubSub upstream，不暴露 central callback endpoint。

## 5. Slice 3：Standalone Sidecar Worker Lifecycle

目标：先不依赖 WorkerPool scale loop，手动启动一个 standalone sidecar，让它作为 Worker 运行实体通过同一个 Worker lifecycle contract 注册、首个 heartbeat 后进入 ready、持续保活、drain/evacuate/close、以及过期摘除。这个 slice 要把 Worker 作为可用 capacity 的完整生命周期做好，而不是只证明一次 register 成功。

实现范围：

- Sidecar daemon 的 standalone worker mode，启动参数包含 central URL、tenant id、sidecarClass、labels、capacity 和可选 description。Worker runtime identity 是 `workerId`；hostname、pod name、container id 只能作为 labels 或 description。
- Sidecar 使用 central URL 和 tenant id 调用 `/sidecar/negotiate?tenantId=<tenantId>`，在 JSON body 中提交 sidecarClass、labels、capacity、allocatable 和可选 description。
- Central 在 `/sidecar/negotiate` boundary 内创建 WorkerRecord，写 central-authored `worker.registered` lifecycle event，并返回 Web PubSub client access URL 与 central 分配的 `workerId`。
- Sidecar 使用 access URL 连接 runtime transport 后，订阅 `worker-commands:{workerId}` runtime channel。
- Register 只创建 registered Worker fact；Worker 必须 publish 首个 `worker.heartbeat` 后才进入 active ready selection path。
- Sidecar 定期 publish `worker.heartbeat`，刷新 `heartbeatAt`、`expiresAt`、capacity、allocatable、conditions。
- Central Worker lifecycle reconciler 周期性调用 keepalive expiry scan。过期 Worker 触发 evacuate：central 从 active registry 移除 Worker，append `worker.expired`，对其持有的 session lease append `session.lease.lost`，POC 默认把 session 置为 `failed`。
- Drain 是主动迁移流程：central 把 Worker 标记为 `draining`，停止新 assignment，尝试让该 Worker 上的 session 离开并在其他 active 且 label 匹配的 Worker 上启动。POC 迁移能力不足时按 session policy 默认 failed。Drain 完成后 central publish `worker.close.requested`，Worker graceful 退出。
- Close 是 terminal：central append `worker.closed`，从 active registry 移除 Worker；后续 heartbeat 必须 rejected，不能复活。
- `WorkerManager` 写 `workers/<workerId>.json` 作为历史 record，并维护 active worker registry view。Terminal record 可以保留供 debug/audit，但 selection/list active 不能返回。
- Worker record 包含 `workerId`、`sidecarClass`、labels、description、capacity、allocatable、conditions、`heartbeatAt`、`expiresAt`、terminal reason。
- `WorkerRuntimeEventController` 解析 worker runtime events，`WorkerManager` 处理 register、first heartbeat readiness、heartbeat refresh、condition/capacity update、drain、evacuate、close、active state removal。
- Session assignment 写 `currentWorkerId` 和 `sessionLeaseId`。Sidecar 写 session-scoped events 必须携带当前 `sessionLeaseId`；central 拒绝旧 lease 或未知 lease。
- `WorkerSelector` 只读取 active registry 中 ready、未过期、allocatable、label 匹配的 Worker facts。

Scenario-based test：`scenario: standalone sidecar registers worker and becomes ready after first heartbeat`

Given：

- Central tenant runtime 已启动。
- Standalone sidecar 带着 `sidecarClass=copilot-process-wrapper`、`labels.agent=copilot` 和 capacity 1 启动。
- WorkerPool scale loop 未参与本 scenario。

Expect：

- Central 分配 `workerId`。
- Worker record 的 `sidecarClass` 是 `copilot-process-wrapper`。
- Worker labels 包含 `agent=copilot`。
- Register 后但首个 heartbeat 前，Worker 不在 ready selection path。
- 首个 heartbeat 后，Worker capacity/allocatable 是 1，condition 是 `ready`，并进入和后续 WorkerPool provisioned Worker 相同的 selection path。
- Central 不调用 WorkerPool controller 或 hostPoolAdapter。

Scenario-based test：`scenario: sidecar negotiates real Web PubSub connection and registers worker`

Given：

- `tests/.env` 提供 `WEBPUBSUB_ENDPOINT`。
- Central HTTP server 已启动，并暴露 `/sidecar/negotiate?tenantId=<tenantId>`。
- Central runtime 使用真实 Web PubSub client connection 订阅 tenant inbox runtime channel。
- Standalone sidecar 只拿到 central URL、tenant id、labels、capacity 和可选 description。

Expect：

- Sidecar 调用 central `/sidecar/negotiate?tenantId=<tenantId>`，body 中包含 sidecarClass、labels、capacity、allocatable。
- Central 创建 WorkerRecord，并为该 tenant 的 tenant inbox 与 `worker-commands:{workerId}` runtime channels 颁发 Web PubSub client access URL。
- Sidecar 使用 access URL 建立真实 Web PubSub client connection。
- Sidecar 使用 negotiate response 中的 `workerId` 订阅 worker commands runtime channel。
- Sidecar 使用该 `workerId` publish 首个 `worker.heartbeat`。
- Central 收到首个 heartbeat 后写入 active ready Worker record。
- Worker record 的 tenant 来自 `/sidecar/negotiate` 解析出的 tenant runtime；sidecar negotiate body 不自报 `tenantId`。
- Worker record 的 labels、capacity、allocatable、conditions 满足后续 selection contract。

Scenario-based test：`scenario: worker heartbeat refreshes active capacity`

Given：

- Worker 已注册且在 active worker index 中。
- Sidecar publish `worker.heartbeat`，带新的 `heartbeatAt`、capacity、allocatable、conditions。

Expect：

- Central 更新 Worker record 的 `heartbeatAt` 和 `expiresAt`。
- Central 更新 capacity、allocatable、conditions。
- Worker 仍在 active worker index 中。
- 如果 Worker condition 是 `ready` 且 allocatable 大于 0，Worker selection 可以选择它。

Scenario-based test：`scenario: drain evacuates sessions then closes worker`

Given：

- Worker 已注册且可能持有 active session lease。
- Central 收到 `worker.drain.requested`。

Expect：

- Central append `worker.draining` event。
- Worker condition 变为 `draining`，allocatable 变为 0，Worker selection 不再返回该 Worker。
- Central 对该 Worker 上的每个 session lease 执行 drain：尝试选择其他 active 且 label 匹配的 Worker 并写入新的 `sessionLeaseId`。
- POC 若不能恢复该 session，则 append `session.lease.lost`，session 进入 `failed`，记录 `worker_lost` reason。
- Worker 上没有 active lease 后，central publish `worker.close.requested`。
- Worker graceful 退出后停止 heartbeat；central append `worker.closed` 并从 active registry 移除 Worker。

Scenario-based test：`scenario: graceful worker close removes worker from active registry`

Given：

- Worker 已 drain 完成且没有 active lease。
- Central publish `worker.close.requested`，Worker graceful 退出或 sidecar publish `worker.close.requested`。

Expect：

- Central append `worker.closed` event。
- Worker record 进入 terminal closed state，并记录 reason。
- Worker 从 active registry 移除，Worker selection 不再返回该 Worker。
- 后续 heartbeat 被 rejected，不能让该 Worker 回到 active。

Scenario-based test：`scenario: expired worker is evacuated and removed from active registry`

Given：

- Worker 已注册且在 active worker index 中。
- Central time 超过该 Worker 的 `expiresAt`。
- 没有收到新的 `worker.heartbeat`。

Expect：

- Central Worker lifecycle reconciler 周期性运行 keepalive expiry scan，并 append `worker.expired` event。
- Worker record 进入 expired/disconnected terminal state，并记录 last heartbeat。
- Worker 从 active registry 移除。
- Worker selection 不再返回该 Worker。
- 如果 Worker 持有 session lease，central append session-scoped `session.lease.lost` event；POC 默认把 session 置为 `failed`。
- 过期摘除不依赖 Worker source，也不要求 dead Worker ack。

Scenario-based test：`scenario: leased worker close marks session lease lost without crash recovery`

Given：

- Worker 已被某个 session lease 持有。
- Sidecar close 发生在 lease release 之前。

Expect：

- Central append `worker.closed` event。
- Central append session-scoped `session.lease.lost` event。
- Worker 从 active registry 移除。
- Session 不再向该 Worker route input。
- POC 不自动恢复该 session；session 进入 `failed`，并记录 `worker_lost` reason。

Scenario-based test：`scenario: leased worker expiry marks session lease lost without crash recovery`

Given：

- Worker 已被某个 session lease 持有。
- Central time 超过该 Worker 的 `expiresAt`，并且 lease release 尚未发生。

Expect：

- Central append `worker.expired` event。
- Central append session-scoped `session.lease.lost` event。
- Worker 从 active registry 移除。
- Session 不再向该 Worker route input。
- POC 不自动恢复该 session；session 进入 `failed`，并记录 `worker_lost` reason。

Scenario-based test：`scenario: stale heartbeat cannot resurrect removed worker`

Given：

- Worker 已经进入 terminal state，并已从 active registry 移除。
- Central 随后收到该 `workerId` 的迟到 `worker.heartbeat`。

Expect：

- Central 不把该 Worker 放回 active registry。
- Central 不更新该 Worker 为 `ready`。
- Central append `worker.heartbeat.rejected` event。
- 仍然活着的 sidecar/worker 必须重新调用 `/sidecar/negotiate`，形成新的 `workerId`。

## 6. Slice 4：Client SDK Create Session And Assignment

目标：从客户侧 SDK 开始跑通 create session 到 assignment 的端到端主线。SDK 调用 central REST negotiate，使用 Web PubSub publish `session.create.requested`，central 写 durable session truth，选择 registered ready Worker，写入 lease，并把 `session.assign` 发到 worker commands runtime channel。

分层约束：Central 内部以 `TenantRuntime` 作为 tenant-scoped composition root 和 ingress shell。处理 Web PubSub runtime event、REST negotiate、未来 gRPC/queue 等入口协议的类命名为 Controller，代表可替换协议边界；维护 session lifecycle、turn sequence、assignment、event log、worker registry/lease 等 tenant 内部流程和状态机制的类命名为 Manager。`TenantRuntime` 不直接实现 session create/input workflow，只委托给 tenant-owned controllers/managers。

实现范围：

- `sdk/` 目录下建立客户侧 SDK，不 import `src/`。
- `sdk/client/public-protocol-spec-ch.md` 记录 SDK 依赖的 public REST endpoint、query、runtime channels、event types、payload schemas、Web PubSub group 语义。
- SDK public API：`connect`、`sessions.start`、`sessions.open`、`SessionHandle.send`、`AgentTurn.events`、`AgentTurn.waitForResult` 的 POC 版本。
- SDK REST path：`POST /client/negotiate?tenantId=<tenantId>&clientConnectionId=<client-startup-random-string>`。
- SDK Web PubSub path：connect 后 publish `session.create.requested` 到 tenant inbox runtime channel。
- SDK 内部持有自己的 public protocol types，按 `sdk/client/public-protocol-spec-ch.md` 对齐，不从 `src/shared` import。
- `TenantRuntime` 只作为 tenant composition root 和 ingress shell，订阅 tenant inbox 后委托给 protocol-facing controllers。
- `TenantInboxController` dispatch Web PubSub runtime events。
- `ClientRuntimeEventController` 解析 `session.create.requested`、`input.received`，并把协议 event 转为 session manager command。
- `WorkerRuntimeEventController` 解析 worker heartbeat/drain/close runtime events，并转给 worker manager；Worker registration 属于 `/sidecar/negotiate` HTTP boundary。
- `SessionManager` 在 durable truth 写入后触发 assignment workflow。
- `SessionLifecycleManager` 生成 central-owned session id 和 session-scoped `turnSeq`。
- `SessionAssignmentManager` 调用 `WorkerSelector` 和 `SessionLeaseManager`，生成 `session.assign` worker command。
- `WorkerManager` 维护 Worker active registry、historical worker records、heartbeat、drain、evacuate、close、expiry 和 session lease lost effects。
- `currentWorkerId`。
- `sessionLeaseId`。
- `session.assign` command publish 到 worker commands runtime channel。
- Worker command subscriber 用真实 Web PubSub connection 验证收到 `session.assign`。

Scenario-based test：`scenario: client SDK creates session and assignment reaches registered worker`

Given：

- `tests/.env` 提供 `WEBPUBSUB_ENDPOINT`。
- Central HTTP server 已启动，并暴露 `/client/negotiate?tenantId=<tenantId>&clientConnectionId=<client-startup-random-string>`。
- Central runtime 使用真实 Web PubSub client connection 订阅 tenant inbox runtime channel。
- Standalone sidecar 已通过 Slice 3 workflow 注册为 active ready Worker。
- Worker command subscriber 已连接真实 Web PubSub，并订阅该 Worker 的 worker commands runtime channel。
- Client SDK 只拿到 central URL、tenant id、AgentSpec id、initial message 和 workspace source；SDK 内部生成 `ackId`，runtime identity 由 central 生成。
- WorkerPool scale loop 未参与本 scenario。

Expect：

- Client SDK 生成 client 启动级随机 `clientConnectionId`，并调用 central `/client/negotiate?tenantId=<tenantId>&clientConnectionId=<clientConnectionId>`。
- Client SDK 使用 access URL 建立真实 Web PubSub client connection。
- Client SDK join negotiated tenant client inbox 和 client private inbox runtime channels。
- Client SDK 生成 `ackId`，publish `session.create.requested` 到 tenant inbox runtime channel；Client 不生成 `sessionId` 或 `turnSeq`。
- Central append `session.created` event，生成 central-owned `sessionId` 和 initial `turnSeq = 1`，并写入 `sessions/<sessionId>/session.json`。
- Central publish 带同一 `ackId` 的 `session.created.ack` acknowledgement 到 client private inbox；SDK 用该 acknowledgement 返回 `StartSessionResult`。Central 同时 publish session catalog/status projection 到 tenant client inbox。
- Central 选择 registered ready Worker。
- Session status 变为 `starting`。
- Session record 写入 `currentWorkerId` 和新的 `sessionLeaseId`。
- Central publish `session.assign` 到 worker commands runtime channel。
- Worker command subscriber 收到 `session.assign`，payload 包含 session id、worker id、session lease id、workspace ref、resolved AgentSpec。
- 不匹配 labels 的 Worker 不会被选择。
- Central 不尝试 scale 出新 Worker。
- Client SDK 不知道 Worker endpoint。

Scenario-based test：`scenario: SDK public protocol spec stays aligned with runtime public protocol`

Given：

- `sdk/client/public-protocol-spec-ch.md` 已定义 SDK 使用的 REST endpoint、query、runtime channels、event types、payload schemas。
- SDK 源码、central public handlers、sidecar public handlers 已存在。

Expect：

- SDK 不 import `src/`。
- SDK public event type、payload shape、REST path、query key 与 `sdk/client/public-protocol-spec-ch.md` 一致。
- Central 和 sidecar 的 public protocol tests 覆盖同一组 contract。
- 修改 public protocol 时，本 scenario 指向的 SDK spec、SDK code、runtime handlers、e2e tests 同步更新。

## 7. Slice 5：Sidecar Copilot Process Wrapper Event Loop

目标：已注册 Worker 的 sidecar 收到 `session.assign` 后，在分配给该 session 的 workspace 和 agent session state 目录上启动 agent runtime，并跑通同一个 session 的多轮 input/output event loop。这个 slice 是 POC 交互主线的完成点：启动真实模型-backed agent runtime 和多轮交流必须作为一个可观察行为一起完成。

实现范围：

- Sidecar lease command controller 订阅 worker commands runtime channel，并校验 `sessionId`、`workerId`、`sessionLeaseId`。
- Sidecar assigned-session manager 在 sidecar 进程内维护 lease-scoped agent run state。
- Sidecar workspace adapter 根据 assignment 准备本地 workspace 目录，并把该目录作为 agent runtime cwd。
- Sidecar agent session state adapter 准备 per-session state directory/volume；POC 使用该位置承载 adapter-owned session files 和 adapter-local metadata，供后续 Docker volume snapshot/restore 保留。
- Resolved runtime config 只来自 `session.assign` payload 和 sidecar 内存中的 per-session adapter state；sidecar 直接把 resolved AgentSpec、provider/profile/model、MCP/skills/tools、permission policy 和 session metadata 传给 `agentProcessAdapter`。
- Agent process adapter 使用 role-named `agentProcessAdapter` contract；POC concrete adapter 在 sidecar 进程内被调用，接收 workspace path、agent session state path 和 resolved runtime config，并通过 GitHub Copilot SDK 启动 Copilot agent session。Copilot 背后的模型来源通过显式 Copilot SDK provider config 指定；sidecar 只传递 provider config，不直接调用 Azure OpenAI/OpenAI chat completions。
- `COPILOT_CLI_PATH` 可以显式指定 Copilot CLI runtime path；`COPILOT_GITHUB_TOKEN`/`GITHUB_TOKEN`/`GH_TOKEN` 可以作为 Copilot SDK 认证输入。Provider config 只接受 `COPILOT_MODEL`、`COPILOT_PROVIDER_TYPE`、`COPILOT_PROVIDER_BASE_URL`、`COPILOT_PROVIDER_TOKEN_SCOPE`、`COPILOT_PROVIDER_WIRE_API` 和 `COPILOT_PROVIDER_AZURE_API_VERSION`。sidecar 用 Azure Identity/MSI 获取 provider bearer token 并传给 Copilot SDK；provider type 和 base URL 必须由用户显式提供，sidecar 不根据 endpoint 猜测或改写 provider URL。
- Runtime-visible session identity、lease、event ordering 和 status truth 都由 central/tenant runtime 持有；Client SDK 只通过 central/session runtime channels 通信，不知道 Worker endpoint。
- Sidecar 在 agent runtime ready 后 publish `status.changed` 到 tenant inbox runtime channel；central append status event，并把 session status 推进到 `running`。
- Client SDK input event handling。
- Central 每轮先 append input event 到 session event log，再 route `session.input` worker command 到当前 `sessionLeaseId` 对应的 Worker。
- Sidecar 将 `session.input` 转成 agent process adapter 的 submit/send 调用。
- Sidecar 把 Copilot output、tool event、permission request、user input request、status event、error event 转成 runtime event publish 到 tenant inbox runtime channel，并携带当前 `sessionLeaseId`。
- Sidecar 在每轮最终结果后 publish `turn.completed`，在失败后 publish `turn.failed`；central append terminal turn events and fan-out to session events runtime channel。SDK 只从 `turn.completed`/`turn.failed` 映射 turn terminal，不从普通 `agent.output` 推断完成。
- 同一 session 的 turn correlation、event cursor、session lease id 和 stale command rejection。
- Sidecar graceful close 时先停止接收新 input，再请求 agent process shutdown；process exit 转成 session/worker status event。

Scenario-based test：`scenario: registered sidecar starts Copilot runtime and reports running`

Given：

- Sidecar 收到 `session.assign`。
- Assignment 包含 session id、worker id、session lease id、workspace ref/path、agent session state ref/path、resolved AgentSpec 和 runtime config。

Expect：

- Sidecar 记录 current session lease id。
- Sidecar 准备本地 workspace 目录，并把它作为 agent runtime cwd。
- Sidecar 准备本地 agent session state 目录。
- Sidecar 把 assignment 中的 resolved AgentSpec/runtime config 保存到 lease-scoped agent run state，并直接传给 agent process adapter。
- Agent process adapter 收到 session id、workspace path、agent session state path 和 resolved runtime config。
- POC concrete adapter 建立 GitHub Copilot SDK agent session，并通过 adapter contract 报告 readiness。
- Agent runtime ready 后，sidecar publish `status.changed` 到 tenant inbox runtime channel。
- Central append status event，并把 session status 推进到 `running`。

Scenario-based test：`scenario: same session supports multi-turn Copilot exchange`

Given：

- Session 已 assigned 给 registered ready Worker，并且 Copilot SDK agent session 已 running。
- Client SDK publish 第一轮 input event 到 tenant inbox runtime channel。
- Client SDK 随后对同一个 `sessionId` publish 第二轮 input event。

Expect：

- Central 在每一轮都先 append input event 到 `events.jsonl`，再 route `session.input` worker command 到当前 Worker。
- Worker command payload 包含 session id、turn seq、worker id、session lease id 和 input payload。
- Sidecar 校验 session lease id 后，把两轮 input 转给同一个 agent process/session context。
- 如果 input 早于 agent ready 到达，sidecar 在同一 session lease 内等待 agent ready，而不是拒绝为 unknown session。
- Sidecar 对每一轮都 publish output event 到 tenant inbox runtime channel；如果 agent adapter 产生 progress/tool/permission/user-input/status/error event，也走同一入口。
- Central append 两轮 output event、两轮 `turn.completed` event，并 append 同一 session 内的 tool/permission/user-input/status/error event。
- Central publish 已持久化的 agent-generated events 到 session events runtime channel。
- Client SDK 可以按 event cursor 看到同一个 session 的连续多轮回复。
- Client SDK 不知道 Worker endpoint。

Scenario-based test：`scenario: stale worker command cannot reach Copilot runtime`

Given：

- Session 当前 `sessionLeaseId` 是 `lease-current`。
- Sidecar 收到旧 `sessionLeaseId=lease-old` 的 `session.input` worker command。

Expect：

- Sidecar 不把 input 转给 agent process adapter。
- Sidecar publish `worker.command.rejected` 到 tenant inbox runtime channel，reason 是 `stale_session_lease`。
- Central append rejection event。
- Session event log 不出现由该 stale command 产生的 agent output。

Automated scenario test 使用实现同一 `agentProcessAdapter` contract 的 deterministic agent test harness；真实 smoke test 必须启动 GitHub Copilot SDK agent session 并验证同一路径能产生真实回复。测试必须经过 central-owned event log、worker command channel 和 session events channel，不允许使用任何 sidecar-local HTTP/WebSocket 旁路来满足 session 行为。

## 8. Slice 6：Queued Session Scheduler And Idle Pause Policy

目标：Central 对 active session 做 tenant-scoped lifecycle reconciliation：queued session 在 activity window 内持续尝试分配 Worker；超过 AgentSpec idle pause timeout 的 queued/running session 进入 paused，并释放 Worker lease。Client 重新打开 session 只读取 history/status，不唤醒 session；只有 client 明确 resume 才把 paused session 放回 queued，重新进入调度路径。

实现范围：

- AgentSpec 增加 `idlePauseTimeoutMs`，由 admission manager 解析为 resolved AgentSpec runtime policy。POC 静态 AgentSpec 默认值是 `120000`，要覆盖 queued session 等待 Worker scale-out 的时间。
- `SessionRecord` 增加 `lastEventUpdatedAt`。`session.created` 写入时初始化该字段；`input.accepted`、`agent.output`、`turn.completed`、`turn.failed`、`status.changed`、`session.pause.requested`、`session.paused`、`session.resume.requested`、`session.resumed` 等 session-scoped durable events 写入后刷新该字段。
- Client connect、`sessions.open(sessionId)`、`sessions.list()`、`session.history()`、session events subscribe/replay 不刷新 `lastEventUpdatedAt`，也不改变 session status。
- Tenant runtime 增加 session lifecycle reconciler。Central 周期性运行该 reconciler；Worker register 或 heartbeat 让 Worker 进入 ready selection path 后，central 立即运行同一个 reconciler 一次。
- Reconciler 扫描当前 tenant 的 session。`queued` 且 `now - lastEventUpdatedAt < idlePauseTimeoutMs` 的 session 进入 assignment workflow；matching ready Worker 存在时写入新的 `sessionLeaseId` 和 `currentWorkerId`，status 变为 `starting`，并 publish `session.assign`。
- `queued` 且 `now - lastEventUpdatedAt >= idlePauseTimeoutMs` 的 session 进入 `paused`，append `session.paused`，reason 是 `idle_timeout`。Paused session 不会被 reconciler 主动 assignment。
- `running` 且 `now - lastEventUpdatedAt >= idlePauseTimeoutMs` 的 session 进入 central-initiated pause：central append `session.pause.requested`，reason 是 `idle_timeout`，status 变为 `pausing`，并向当前 Worker publish pause command。Sidecar 在 turn boundary 停止接收新 input、flush agent state，然后 ack pause；central append `session.paused`，清空 `currentWorkerId` 和 `sessionLeaseId`，释放 Worker capacity。Slice 8 再把这个 pause boundary 扩展为 Docker volume snapshot；本 slice 的完成条件是 durable event boundary、status truth 和 worker lease release 正确。
- `running` session 收到 client `session.pause.requested` 后，central append `session.pause.requested`，reason 是 `client_requested`，status 变为 `pausing`，并向当前 Worker publish pause command。Sidecar ack `session.paused` 后，central 释放 Worker lease，并立即运行同一个 session lifecycle reconciler，让其他 eligible queued session 可以获得刚释放的 Worker。
- `paused` session 收到 `session.resume.requested` 后，central append `session.resume.requested`，刷新 `lastEventUpdatedAt`，status 变为 `queued`。Resume 本身是 session activity，因此刚 resume 的 session 不会在同一轮 reconciler 中被 idle pause。后续 assignment 与普通 queued session 使用同一路径。
- Sample web client 显示 paused/queued/running status，在 running session 上提供 Pause action，在 paused session 上提供 Resume action；打开历史不触发 resume。

Scenario-based test：`scenario: queued session is assigned when matching worker becomes ready`

Given：

- Session status 是 `queued`。
- Session `lastEventUpdatedAt` 距当前时间小于 resolved AgentSpec `idlePauseTimeoutMs`。
- 创建 session 时没有 matching ready Worker。
- 随后 standalone sidecar 通过 `/sidecar/negotiate` 注册，并 publish 首个 ready heartbeat。

Expect：

- Worker heartbeat 写入 active ready Worker record。
- Session lifecycle reconciler 选择该 Worker。
- Central 写入新的 `sessionLeaseId` 和 `currentWorkerId`。
- Session status 变为 `starting`。
- Central publish `session.assign` 到该 Worker 的 worker commands runtime channel。
- Client 不需要保持连接，assignment 不依赖 client open/attach。

Scenario-based test：`scenario: idle queued session pauses and is not auto-assigned`

Given：

- Session status 是 `queued`。
- Session `lastEventUpdatedAt` 距当前时间达到 resolved AgentSpec `idlePauseTimeoutMs`。
- Matching ready Worker 随后注册成功。

Expect：

- Reconciler append `session.paused`，reason 是 `idle_timeout`。
- Session status 变为 `paused`。
- Session 不写入 `currentWorkerId` 或 `sessionLeaseId`。
- Central 不 publish `session.assign`。
- 后续 Worker heartbeat 不会自动唤醒该 paused session。

Scenario-based test：`scenario: idle running session pauses and releases worker lease`

Given：

- Session status 是 `running`。
- Session 持有 `currentWorkerId` 和 `sessionLeaseId`。
- Session `lastEventUpdatedAt` 距当前时间达到 resolved AgentSpec `idlePauseTimeoutMs`。
- 当前 Worker 仍 active。

Expect：

- Central append `session.pause.requested`，reason 是 `idle_timeout`。
- Session status 变为 `pausing`。
- Central publish pause command 到当前 Worker。
- Sidecar 到达 turn boundary 后停止接收新 input 并 flush agent session state。
- Central append `session.paused`。
- Session status 变为 `paused`。
- Session 清空 `currentWorkerId` 和 `sessionLeaseId`。
- Worker capacity 被释放，Worker selection 可把该 Worker 分配给其他 eligible queued session。

Scenario-based test：`scenario: opening a session does not refresh activity or resume it`

Given：

- Session status 是 `paused`，并且有 persisted history。
- Client SDK connect 后调用 `sessions.open(sessionId)` 和 `session.history(0)`。

Expect：

- Central 返回 session history。
- Session status 仍是 `paused`。
- Session `lastEventUpdatedAt` 不变。
- Central 不 publish `session.assign`。
- Central 不改变 Worker registry 或 Worker capacity。

Scenario-based test：`scenario: client pause releases worker and assigns next queued session`

Given：

- Session A status 是 `running`，并持有 Worker lease。
- Session B status 是 `queued`，且仍在 `idlePauseTimeoutMs` activity window 内。
- Client SDK 对 Session A publish `session.pause.requested` 到 tenant inbox runtime channel。

Expect：

- Central append `session.pause.requested`，reason 是 `client_requested`。
- Session A status 变为 `pausing`。
- Central publish pause command 到 Session A 当前 Worker。
- Sidecar ack `session.paused` 后，Session A status 变为 `paused`，并清空 `currentWorkerId` 和 `sessionLeaseId`。
- Worker capacity 被释放。
- Session lifecycle reconciler 立即选择刚释放的 Worker 给 Session B。
- Session B status 变为 `starting`，并收到 `session.assign` worker command。

Scenario-based test：`scenario: resume moves paused session back to queued before assignment`

Given：

- Session status 是 `paused`。
- Session 有 `lastEventUpdatedAt` 和 resolved AgentSpec `idlePauseTimeoutMs`。
- Client SDK publish `session.resume.requested` 到 tenant inbox runtime channel。

Expect：

- Central append `session.resume.requested`。
- Central 刷新 `lastEventUpdatedAt`。
- Session status 变为 `queued`。
- Reconciler 对该 queued session 运行 assignment workflow。
- 如果存在 matching ready Worker，session status 变为 `starting`，并 publish `session.assign`。
- Resume 不使用 client open/history 作为隐式触发。

## 9. Slice 7：Docker WorkerPool Scale Loop

目标：在 standalone sidecar worker 闭环、queued assignment 和 idle pause policy 已经跑通后，增加一个 tenant-scoped WorkerPool scale loop。WorkerPool 不是 Worker，而是能 scale 出 Worker 的配置和策略 owner；它声明要生成的 Worker labels、`hostPoolControllerClass` 和 scale policy，并由 WorkerPool controller 调用对应 hostPoolAdapter。POC 的第一个 hostPoolAdapter 是 Docker，启动出来的 container 默认运行 sidecar，sidecar 仍然通过同一个 `/sidecar/negotiate` registration contract 成为普通 Worker。

实现范围：

- `containers/sidecar/Dockerfile`。基础镜像使用 Ubuntu/Node 20 系列，安装 Azure CLI，启用 Node/pnpm runtime；默认 command 运行 `node dist/sidecar/main.js`，启动后自动读取环境变量并作为 sidecar 注册 Worker。
- POC Docker WorkerPool config。配置属于 tenant runtime，包含 `poolId`、`sidecarClass=copilot-process-wrapper`、Worker 启动时使用的 `labels={ agent: 'copilot' }`、`capacityPerWorker=1`、`hostPoolControllerClass='docker'`、`scalePolicy.scaleOutMaxPendingPerTick=1`、`scalePolicy.scaleInIdleMs=5000`、以及 container 内访问 central 的 `centralUrlForWorkers`。
- WorkerPool controller。它扫描 queued sessions、active Worker records 和 adapter-owned pending instance metadata；当存在 matching queued session、没有 matching ready Worker、也没有 matching pending instance 时，每轮最多 scale out 一个 Worker。
- hostPoolAdapter interface。接口表达 `scaleOut` 和 `scaleIn` 两个 host 操作；真正操作 Docker 的是 Docker hostPoolAdapter，WorkerPool controller 只按配置和策略调用 adapter。
- Docker hostPoolAdapter。它 build/run sidecar image，传入 `CENTRAL_URL`、`TENANT_ID`、Worker labels、Copilot provider env、Web PubSub env、workspace root、Copilot session state root 和 `AZURE_CONFIG_DIR`；本地 Windows 开发模式下把宿主机 Azure CLI profile mount 到 container 的 `/home/sidecar/.azure`。
- Adapter-owned instance metadata。Docker adapter 记录 `containerId`、`poolId`、`workerId?`、pending/ready/stopping/stopped 状态和 idle timestamp；container id 和 WorkerPool source 不进入 Worker selection 条件。
- Worker registration correlation。Docker sidecar 通过 `/sidecar/negotiate` 注册后，adapter/controller 把 `workerId` 和 `containerId` 关联；注册后的 Worker record shape 与 standalone sidecar 一致。
- Docker workspace volume 和 Docker Copilot session volume。Sidecar container 使用这些 volume 路径承载 workspace 和 adapter-owned Copilot session state files。
- Scale in policy。只对 WorkerPool provisioned Worker 生效；Worker 必须是 active、ready、`currentSessionCount=0`、`allocatable=capacity` 且 idle 达到该 WorkerPool 的 `scaleInIdleMs`。Controller 先让 Worker 进入不可再分配状态，再调用 Docker hostPoolAdapter stop/remove 对应 container。

Scenario-based test：`scenario: docker sidecar image can use mounted Azure CLI auth on Windows host`

Given：

- Docker 可用。
- 宿主机是 Windows，并且本机 Azure CLI 已完成 `az login`。
- `containers/sidecar/Dockerfile` 已 build 成 POC sidecar image。
- 宿主机 Azure CLI profile mount 到 container `/home/sidecar/.azure`，并设置 `AZURE_CONFIG_DIR=/home/sidecar/.azure`。

Expect：

- Container 内 `az account show` 成功。
- Container 内 `az account get-access-token --scope https://cognitiveservices.azure.com/.default` 成功。
- Container 内 Node probe 使用 `DefaultAzureCredential().getToken('https://cognitiveservices.azure.com/.default')` 成功。
- 该验证不把 token、profile 内容或 secret 写入 repo。

Scenario-based test：`scenario: queued session causes docker worker pool to scale out a sidecar worker and later scale it in after idle`

Given：

- Session status 是 `queued`。
- Worker registry 中没有 matching ready Worker。
- AgentSpec `workerSelector` 需要 `agent=copilot`。
- POC Docker WorkerPool 声明它能 scale 出 `sidecarClass=copilot-process-wrapper`、`labels.agent=copilot`、capacity 1 的 Worker。
- WorkerPool `hostPoolControllerClass` 是 `docker`，并绑定 Docker hostPoolAdapter。

Expect：

- WorkerPool controller 选择 matching WorkerPool。
- WorkerPool controller 因没有 matching ready Worker 且没有 matching pending instance，调用 Docker hostPoolAdapter scale out。
- Docker hostPoolAdapter 启动 sidecar container，并记录 adapter-owned `containerId`。
- Sidecar container 通过 `/sidecar/negotiate` 注册 Worker。
- Central 分配 `workerId`。
- Docker hostPoolAdapter/controller 把 `containerId` 与 `workerId` 关联。
- Worker record shape 与 standalone sidecar 注册出的 Worker 一致。
- Worker record 的 `sidecarClass` 是 `copilot-process-wrapper`。
- Worker labels 包含 `agent=copilot`。
- Worker capacity/allocatable 是 1。
- Worker condition 是 `ready`。
- Provisioned Worker ready 后，Slice 6 的 session lifecycle reconciler 把 queued session assignment 给新 Worker。
- Session status 变为 `starting`，随后在 sidecar 启动 Copilot 后变为 `running`。
- Session assignment 后，sidecar 使用 Docker workspace volume 和 Copilot session volume 启动 Copilot-backed agent runtime。
- 该 Worker 能完成至少一轮 input/output event loop。
- Session pause/release 后，该 Worker idle 达到 WorkerPool `scaleInIdleMs=5000`。
- WorkerPool controller 调用 Docker hostPoolAdapter scale in，并 stop/remove 对应 container。
- Worker selection 从头到尾只看注册后的 Worker record，不使用 Docker container id，也不使用 WorkerPool source。
- Client SDK 仍然只面向 session 通信，不知道 WorkerPool、Docker container、Worker endpoint。

## 10. Slice 8：Durable Session Memory Across Worker Recycle

目标：把 pause + snapshot 和 resume + restore 合并成一条可验证的 continuity 主线。Session 在一个 Worker 上聊一轮、写下 workspace 文件，pause 时把 workspace 和 agent session state 捕获到 session-addressed snapshot 区，Worker 被回收后，resume 在一个新 Worker 上先恢复这两份材料再重启 agent，新一轮对话能读回之前写的文件并续接之前的会话记忆。这条主线不通，durable session 的核心承诺就不成立，所以 pause 与 resume 作为同一个 slice 一起验证。

### 10.1 Snapshot 边界与 ownership

- **Session-addressed snapshot 区**：snapshot 按 `sessionId` 归档，不按 Worker 实例归档。central data root 下的 `snapshots/<sessionId>/<snapshotId>/` 是 durable 存储位置；`snapshot.json` 是 record，`parts/workspace` 和 `parts/agent-state` 是捕获的字节。因为 `sessionId` 不变，任何后续 Worker 只凭 session 身份就能找回最新 snapshot，与写入它的 Worker 是否已销毁无关。
- **Central 拥有 snapshot record 与 marker**：central 分配 `snapshotId` 与 snapshot location、写 `WorkspaceSnapshot` record、append `snapshot.created` marker、维护 `latestSnapshotRef`，并下发 capture/restore 指令。Central 不读 Worker 的活动卷字节。
- **Sidecar 拥有字节搬运**：sidecar 的 workspace adapter 在 pause 时把 `workspacePath` 与 `copilotSessionStatePath` 复制进 snapshot location 的 parts，在 resume 时把 parts 复制回新 Worker 的卷。它是离 agent 最近、知道哪些文件一致的组件。
- **`workspaceClass` 与 `agentStatePolicy` 是 persistentClass**：snapshot 区的具体后端（Docker bind-mount snapshot 目录、对象存储、k8s PVC snapshot）由这两个 class 选择并实现，central 的 snapshot 契约不变。POC 用 Docker bind-mount 的 session-addressed 目录。

### 10.2 Pause + Capture

- Slice 6 已建立的 `session.pause.requested` handling、`running -> pausing -> paused` status truth、pause command 与 turn-boundary pause。
- Central 在下发 pause command 时附带 capture ref（`snapshotId` + snapshot location）。client-requested pause 与 idle pause 使用同一个 capture ref 机制。
- Sidecar 到达 turn boundary 后停止接收新 input，stop agent process adapter 让 Copilot session 文件落盘一致，再调用 workspace adapter capture，把 workspace 与 agent session state 复制进 snapshot location 的 parts。
- Sidecar publish `session.paused`，携带它捕获的 `snapshotId` 与 parts。
- Central 收到 `session.paused` 后写 `WorkspaceSnapshot` record（`baseEventCursor` 对齐 pause event boundary），append `snapshot.created` marker，更新 `latestSnapshotRef`，释放 worker lease，把 session status 变为 `paused`。

### 10.3 Resume + Restore

- `session.resume.requested` handling。Central append `session.resume.requested`，刷新 `lastEventUpdatedAt`，把 paused session 放回 `queued`。
- Session lifecycle reconciler 用与普通 queued session 相同的 assignment path 选择 ready Worker；没有 ready Worker 时 WorkerPool scale 出新 Worker。
- Assignment 写新的 `sessionLeaseId`，assign command 附带从 `latestSnapshotRef` 解析出的 restore ref（`snapshotId` + location + parts）。
- Sidecar 收到带 restore ref 的 assign 后，先调用 workspace adapter restore 把 parts 复制回新 Worker 的 `workspacePath` 与 `copilotSessionStatePath`，再启动 agent process adapter。
- Copilot process adapter 启动后用 `getLastSessionId()` 发现恢复出来的 Copilot session，并 `resumeSession()` 续接它；没有已存在 session 时才 `createSession()`。
- Sidecar 报 `status.changed running`，session status 回到 `running`。

恢复模式固定为 restart-with-context：恢复 workspace、event history 与 agent session state 后重启并续接 agent session。snapshot 缺失或 agent session state part 缺失时进入 `failed`。

Scenario-based test：`scenario: a recycled session restores its workspace and memory before the next turn`

Given：

- Client SDK 创建 session 并完成第一轮：要求 agent 在 workspace 写文件 `continuity.txt`，内容是 `RESUME-OK-7f3a`。
- Session 在 Worker A 上处于 `running`。

Expect：

- 第一轮完成后，central 收到 `turn.completed`。
- Client SDK publish `session.pause.requested`；sidecar 在 stop agent 后 capture workspace 与 agent session state 到 `snapshots/<sessionId>/<snapshotId>/parts`。
- Snapshot 区的 `parts/workspace` 包含 `continuity.txt`，内容是 `RESUME-OK-7f3a`。
- Central 写 `WorkspaceSnapshot` record、append `snapshot.created`、更新 `latestSnapshotRef`，session status 变为 `paused`，Worker A lease 释放。
- Worker A 被回收（本地卷随之销毁），其本地 workspace/agent-state 不再可用。
- Client SDK publish `session.resume.requested`；session 经 `queued -> starting` 分配到新 Worker B。
- Worker B 在启动 agent 前从 `latestSnapshotRef` restore workspace 与 agent session state；Worker B 的 `workspacePath` 包含 `continuity.txt`。
- 第二轮要求 agent 读回它先前创建的文件；turn 输出包含 `RESUME-OK-7f3a`，且 agent 能在不被重新告知文件名的情况下指出 `continuity.txt`。
- Session status 回到 `running`，全程 Client SDK 只面向 session，不知道 Worker A/B、snapshot 区或 Worker endpoint。

## 11. Slice 9：Local Worker Type

目标：用一个 `agent=local` 的 AgentSpec 验证 worker-type 驱动的 adapter binding，并提供不依赖 Docker WorkerPool 的本机 worker。Worker 启动只引用一个 worker type，type 自身注册好 `sidecarClass`、labels、capacity、以及 runtime transport/workspace/agent-process 三个 sidecar adapter class；worker 启动时不再自报 labels、capacity、sidecarClass。`copilot-local` worker 直接复用 worker 所在机器的 Copilot：workspace 与 Copilot session 文件由 Copilot 在本机自管，central 不为它写 snapshot；单 worker capacity 99，等于在本机承载多路 Copilot session。Pause 一个 local session 等于停掉它对应的 Copilot session 并释放一个 capacity 槽，resume 让 Copilot 在同一本机 worker 上 `resumeSession()` 续接。Central 对 session 的 create/queue/assign/lease/event-log/pause/resume 管理与现有 slice 保持一致，只新增 local 这一组 class 选择。

实现范围：

- Worker type registry。新增 sidecar 侧 `WorkerType` 概念：`workerTypeId` 绑定 `sidecarClass`、默认 labels、capacity/allocatable、`runtimeTransportClass`、`workspaceAdapterClass`、`agentProcessAdapterClass`。POC 注册两种 type：`copilot-process-wrapper`（`sidecarClass=copilot-process-wrapper`、labels `agent=copilot`、capacity 1、Docker workspace adapter、Copilot process adapter）和 `copilot-local`（`sidecarClass=copilot-local-process`、labels `agent=local`、capacity 99、local workspace adapter、Copilot process adapter）。
- Sidecar 启动只 ref worker type。`start:sidecar` 读取 `CENTRAL_URL`、`TENANT_ID`、`WORKER_TYPE`，从 worker type registry 解析出 sidecarClass、labels、capacity 和三个 adapter class；不再从 `SIDECAR_LABELS_JSON`/`SIDECAR_CAPACITY` 自报这些值。worker registration body 的 sidecarClass、labels、capacity、allocatable 全部来自 resolved worker type。
- 新 sidecarClass。`SidecarClass` union 增加 `copilot-local-process`，作为 local worker type 的匹配键；`WorkerRecord`、`WorkerPoolRecord`、selector 不按 type 分叉。所有 class 字段（`sidecarClass`、`workspaceClass`、`agentStatePolicy`、`pausePolicy`、`recoveryPolicy`、`hostPoolControllerClass`）都是 registry key：行为来自被解析的 class 实例，central/sidecar 不出现 `if class === 'copilot-local-...'` 这种针对具体值的硬编码分支。
- 新 AgentSpec。新增 `POC_LOCAL_AGENT_SPEC`：`agentSpecId=copilot-local`、`labels.agent=local`、`sidecarClass=copilot-local-process`、`workerSelector.matchLabels.agent=local`、`workspaceClass=local-managed`、`agentStatePolicy=copilot-managed-local`、`pausePolicy=stop-on-pause`、`recoveryPolicy=restart-with-context`、`idlePauseTimeoutMs=120000`。`StaticAgentSpecRegistry` 同时注册 `copilot-poc` 和 `copilot-local`。
- Persistence 是 class，不是 central 的 if-branch。central 新增 `persistentClass` 注册表，key 由 AgentSpec 的 `workspaceClass`+`agentStatePolicy` 解析：`docker-workspace-volume-snapshot`/`copilot-session-volume-snapshot` 解析为 volume-snapshot persistence class，`local-managed`/`copilot-managed-local` 解析为 copilot-self-managed persistence class。central 永远调用 resolved persistentClass 的 `planCapture`/`planRestore`/`recordCapture`，不读 policy 字面量分流。volume-snapshot class 产出 capture/restore ref 并写 `WorkspaceSnapshot`；copilot-self-managed class 的 `planCapture`/`planRestore` 返回空、`recordCapture` 是 no-op，于是“pause 不带 capture、assign 不带 restore、不写 snapshot”作为 class 行为涌现，而不是 central 对 local 特判。`SnapshotCaptureRef`、`SessionAssignPayload.restore` 在契约里变成 optional。
- pausePolicy/recoveryPolicy 也是 class。`turn-boundary-durable-pause` 与 `stop-on-pause` 实现同一 pausePolicy 接口，sidecar 按 resolved pausePolicy class 走到 pause boundary；`stop-on-pause` class 直接停掉 Copilot session 即视为 paused。`restart-with-context` recovery class 启动后 `getLastSessionId()`/`resumeSession()` 续接，缺材料即 fail；central/sidecar 都不按 policy 字面量分支。
- workspaceClass 是 class，local adapter 只是其一种实现。`docker-workspace-volume-snapshot` 解析为 Docker workspace adapter，`local-managed` 解析为 local workspace adapter：mount 本机固定 per-session workspace 与 Copilot session 目录、`capture` 返回空 parts、`restore` no-op；persistence 由 Copilot 自管，central 不读写其字节。
- Worker selection 不变。`WorkerSelector` 仍只按 `sidecarClass`、active、未过期、allocatable>0、labels 匹配；local worker 凭 capacity 99 可承载多 session。
- README。新增一节说明用 `WORKER_TYPE=copilot-local pnpm start:sidecar` 在本机起一个 local worker，并用 `copilot-local` AgentSpec 创建 session，无需 Docker WorkerPool。

Scenario-based test：`scenario: worker type binds adapters so startup only references the type`

Given：

- Worker type registry 注册了 `copilot-local`。
- Sidecar 启动只提供 `CENTRAL_URL`、`TENANT_ID`、`WORKER_TYPE=copilot-local`。

Expect：

- Sidecar 用 type 上的 sidecarClass、labels、capacity 调用 `/sidecar/negotiate`，body 不来自 per-start 环境变量。
- Worker record `sidecarClass=copilot-local-process`、labels 含 `agent=local`、capacity/allocatable 是 99。
- Sidecar 实例化 type 注册的 local workspace adapter 和 Copilot process adapter。

Scenario-based test：`scenario: local agent spec assigns to local worker without docker scale-out`

Given：

- 一个 `copilot-local` worker 已注册并 ready。
- Client SDK 用 `copilot-local` AgentSpec 创建 session。

Expect：

- Central 选中该 local worker，写 lease，session 进入 `starting`→`running`。
- WorkerPool/Docker host pool adapter 不被调用。
- 同一 local worker 上可并发承载多个 session，allocatable 随 assign 递减。

Scenario-based test：`scenario: pausing a local session stops copilot and frees one capacity slot`

Given：

- `copilot-local` session 在 local worker 上 `running`。
- Client SDK publish `session.pause.requested`。

Expect：

- Central 下发的 pause command 不含 capture ref，因为 resolved persistentClass 是 copilot-self-managed，其 `planCapture` 返回空（不是 central 对 local 特判）。
- Sidecar 停掉该 Copilot session，publish `session.paused` 不带 snapshot；central 调 persistentClass `recordCapture`（no-op），不写 `WorkspaceSnapshot`、不更新 `latestSnapshotRef`。
- worker allocatable +1，worker 不被 scale-in。

Scenario-based test：`scenario: resuming a local session reattaches copilot without snapshot restore`

Given：

- `copilot-local` session 处于 `paused`，local worker 仍在线。
- Client SDK publish `session.resume.requested`。

Expect：

- Session 经 `queued`→`starting` 重新分配到同一 local worker，assign 不带 restore ref。
- Copilot process adapter 用 `getLastSessionId()` 续接本机 session，第二轮能续接之前记忆，回到 `running`。

## 12. Slice 10：Durable Interaction Broker For Approval And Client Tools

目标：把 Copilot SDK 的 pending-request 模型桥接成 central-owned durable interaction，让一个 turn 在 agent 请求 off-agent 响应（human approval 或 client 兑现的 tool result）时挂起，并且这个挂起不依赖 client 是否在线，能跨 pause/resume 和 reconnect 继续等待。Agent 自己执行的 built-in/MCP/handler-backed tool 保持纯 observation，不进入 interaction。

实现范围：

- Interaction 边界：一个 turn 只有在 Copilot surface 出 off-agent 请求时才挂起——`permission.requested`（kind `approval`）或 declaration-only tool 被 externalize 成 external tool request（kind `tool_call`）。built-in、MCP、以及带 handler 的 custom tool 由 agent runtime 自己执行，继续走 `tool.started`/`tool.completed` observation，不产生 interaction，也不挂起 turn。执行位置（agent 本地 vs host 兑现）与 approval gate 是两条正交轴：一个 agent 本地执行的 MCP 调用仍可能带 approval gate，此时挂起的是那道 gate，而不是把执行搬到 client。
- Sidecar bridge：移除 `approveAll`。Copilot session 配置为不自动解决 permission（不挂 auto-resolve handler），让 permission 以 pending event 形式 surface；AgentSpec 声明的 client tools 以 declaration-only `Tool`（无 handler）注册，使其调用被 externalize 成 pending external tool request。correlation 直接复用 Copilot 的 `requestId`：sidecar 把 `interactionId` 取成对应 pending request 的 `requestId`（`tool_call` 来自 `external_tool.requested` 的 `requestId`，`approval` 来自 pending permission 的 `requestId`），不另建映射表；resolve 时按 `kind` 把 `interactionId` 当 `requestId` 传回对应 pending RPC。
- Durable interaction event：sidecar 把 `interaction.requested` publish 到 tenant inbox runtime channel，携带 `interactionId`（= Copilot `requestId`，作为回包关联键）、`kind`、`turnSeq`、typed `request` 和当前 `sessionLeaseId`；`tool_call` 的 `request` 带 `toolName`、`arguments`（供 client 执行）和 `toolCallId`（供 trace/分组）。Central append `interaction.requested` 到 `events.jsonl`，并把它加入 session record 的 `openInteractions`。
- Central open-interaction truth：session record 增加以 `interactionId` 索引的 `openInteractions`（含 `kind`、`turnSeq`、requested 时间）。`interaction.requested` 加入，`interaction.responded` 移除。只要该 turn 还有 open interaction，central 就不认为 turn 结束，也不 synthesize `turn.completed`；只有 Worker 真正的 `turn.completed` 才关闭 turn。Placement status（running/paused）与 interaction 正交；client 侧从 `openInteractions` 派生“需要响应”，而不是新增一个互斥 status。
- Client response command：新增 client-authored runtime event `interaction.respond.requested`，携带 `sessionId`、`interactionId` 和 typed `response`。`approval` 的 response 带 `decision`（`approved`/`denied`）和 `scope`（`once` 或 `session`）；`tool_call` 的 response 带 tool result。Central `ClientRuntimeEventController` 处理它：先按 session 和 interaction kind 授权 principal，再校验该 interaction 当前 open，append 带 `scope` 的 `interaction.responded` durable event（`scope: session` 的 approve 即一条可审计的常驻放行记录），从 `openInteractions` 移除，并把 `session.interaction.response` worker command route 到当前 `sessionLeaseId` 对应的 Worker；`interaction.responded.ack` 回 client private inbox。
- Sidecar response command：sidecar 处理 `session.interaction.response` worker command：校验 `sessionLeaseId`，按 `kind` 把 `interactionId` 当 `requestId` 回给对应 pending RPC——`tool_call` → `rpc.tools.handlePendingToolCall({ requestId, result })`，`approval` → `rpc.permissions.handlePendingPermissionRequest({ requestId, result })`，因此 response 精确命中 Copilot 那次 pending request，无需额外映射。`approval` response 的 `scope` 映射到 Copilot permission decision：`once` → `Approved`，`session` → `ApprovedForSession`，让 Copilot permission rule engine 记下 session 级放行规则。挂起的 turn 与 worker command 处理并发进行，resolve 命令能在 turn 挂起期间被接收，不被 in-flight turn head-of-line 阻塞；同一 turn 的多个 open interaction 按 `interactionId` 独立 resolve。
- Standing approval rule（auto-approve after first）：一次 `scope: session` 的 approve 不是 client 端记忆，而是 gate 上的一条 rule。之后命中该 rule 的 gated action 由 Copilot permission rule engine 在 gate 处直接放行，不 surface 成 `interaction.requested`、不挂起 turn、不往返 client；central 靠那条带 `scope` 的 `interaction.responded` 记录该常驻放行以供 audit 与吊销。SDK 不实现有状态的 auto-approver，app 也不盲返回 approval——“第一次问、之后自动”完全由 scope 化 decision + gate rule 承担。本 slice 用 Copilot session permission rule 落地常驻放行；把它泛化成 central-owned approval policy 不在本 slice。
- Pause/resume：带 open interaction 的 session 被 pause 时，`openInteractions` 随 session record 和 event log 持久化（它是 durable fact，不是 worker-local state），pause 照常释放 Worker lease。Resume 重新 lease Worker 并从 agent session state 重启该 turn；central 始终是该 obligation 的 source of truth。Pause 期间收到的 decision 在重启后的 agent 再次请求同一 interaction（按 kind+turn 对齐）时下发；recovery 语义是 restart-with-context，不承诺 tool 调用中点的透明续跑。
- Reconnect / client offline：interaction 存在于 event log 和 `openInteractions`，与任何 client connection 无关。晚到的 client 连接后从历史里 fold `interaction.requested`/`interaction.responded` 得到仍然 open 的 interaction，并通过同一 command 响应；interaction 的存在和持久不需要任何 client 在线。
- SDK surface：Client SDK 把 `interaction.requested`/`interaction.responded` 映射成 typed session event 暴露在 `observe()`，暴露当前 open interactions，并提供 `respond({ interactionId, decision, scope })`（`approval` 可选 `scope: 'once' | 'session'`）以及可选的 per-kind registered handler；handler 只做逐请求的动态决策，不做常驻自动批准。SDK 不暴露 Worker endpoint 或 pending-RPC 机制，也不持有 auto-approve 状态。移除旧的 observation-only `approval.requested` event 和 `agent.output.approvalRequested` 字段，approval 只走 durable interaction。Public protocol 变化同步 `sdk/client/public-protocol-spec-ch.md`、SDK 类型、central/sidecar handler、e2e tests。

Scenario-based test：`scenario: approval interaction survives client absence and resumes the turn`

Given：

- 一个 session 的 agent runtime 在没有任何 client 订阅 session events 时请求一个 gated action（Copilot `permission.requested`）。

Expect：

- Sidecar 让该 Copilot permission 保持 pending，并 publish `interaction.requested{kind:'approval'}` 到 tenant inbox，携带稳定 `interactionId` 和当前 `sessionLeaseId`。
- Central append `interaction.requested` 到 `events.jsonl`，并把它记入 session 的 `openInteractions`；turn 保持 open，不出现 `turn.completed`。
- 无 client 连接时该 interaction 持续存在；随后连接的 client replay history 能看到这个 open `approval` interaction。
- Client publish `interaction.respond.requested{ interactionId, decision: approved, scope: once }` 后，central 授权、append `interaction.responded`、从 `openInteractions` 移除，并 route `session.interaction.response` 到当前 Worker。
- Sidecar 用 pending-permission RPC resolve 该 permission，turn 继续走到真实的 `turn.completed`。

Scenario-based test：`scenario: parallel client tool interactions resolve independently`

Given：

- Agent 在同一个 turn 内发起两个 declaration-only tool 调用。

Expect：

- Sidecar publish 两条 `interaction.requested{kind:'tool_call'}`，`interactionId` 不同、`turnSeq` 相同，两条都保持 pending。
- 先响应第二个 `interactionId` 只 resolve 对应的 Copilot tool request，第一个仍然 open。
- Turn 挂起期间 sidecar 仍在处理 worker command，command 入站不被 in-flight turn 阻塞。
- 两条 `interaction.respond.requested` 都到达后，两个 tool result 都被下发，turn 走到 `turn.completed`。

Scenario-based test：`scenario: agent-executed MCP tool stays observation, not interaction`

Given：

- Agent 调用一个 built-in/MCP/handler-backed tool。

Expect：

- Central append `tool.started`/`tool.completed` observation event，不产生 `interaction.requested`。
- Turn 不挂起，`openInteractions` 保持为空。

Scenario-based test：`scenario: session-scoped approval auto-resolves later matching actions at the gate`

Given：

- 第一个 gated action 的 approval interaction 被 `interaction.respond.requested{ interactionId, decision: approved, scope: session }` 响应。

Expect：

- Central append 带 `scope: session` 的 `interaction.responded`，作为该常驻放行的可审计记录。
- Sidecar 用 `ApprovedForSession` resolve 该 permission，Copilot 记下 session rule。
- 之后同类 gated action 被 gate 直接放行，不产生新的 `interaction.requested`，turn 不挂起、也不往返 client。
- 该常驻放行后 `openInteractions` 对同类动作保持为空。

Scenario-based test：`scenario: open interaction persists across pause and resume`

Given：

- 一个 session 带一个 open `approval` interaction。

Expect：

- Pause 释放 Worker lease，session status 是 `paused`，`openInteractions` 仍包含该 interaction（持久在 session record 和 event log）。
- Resume 重新 lease Worker，该 interaction 仍是 central-owned obligation；重启的 agent 再次请求该 gated action 时，用 `interaction.respond.requested` 记录的 decision resolve 它，turn 继续。

Automated scenario test 使用实现同一 `agentProcessAdapter` contract 的 deterministic agent test harness 驱动 permission/external-tool 的 pending 与 resolve；测试必须经过 central-owned event log、worker command channel 和 session events channel，不允许 sidecar-local 旁路。

## 13. Slice 11：Reconnect And Replay

目标：Client SDK 断线后能用 event cursor 追上 session history。

实现范围：

- Event replay API/function。
- Client SDK reconnect with cursor。
- Session events runtime channel resubscribe。

Scenario-based test：`scenario: reconnect replays events after client cursor`

Given：

- Session event log contains sequence 1 到 5。
- Client SDK reconnects with cursor 2。

Expect：

- Central returns events with sequence 3 到 5。
- Replay comes from `events.jsonl`。
- Replay does not depend on Web PubSub message history。
- Client SDK still does not know Worker endpoint。

## 14. Slice 12：Thin Auth And Audit Boundary

目标：POC 保留 central-owned negotiate 和 audit hook，但不展开完整 production auth matrix。

实现范围：

- `/client/negotiate`。
- `/sidecar/negotiate`。
- Demo principal from POC HTTP route request context。
- Audit append for create、register、pause、resume。

Scenario-based test：`scenario: negotiate is central-owned`

Given：

- Client SDK requests token from central negotiate。
- Sidecar requests token from central negotiate。

Expect：

- Client SDK token is issued by central for the runtime channels allowed in the POC path。
- Sidecar token is issued by central for the runtime channels allowed in the POC path。
- Browser and sidecar do not choose their own `userId`。
- Audit log records token issuance as record-only。

## 15. Recommended Order

按下面顺序实现和 review：

1. Durable session truth。
2. Web PubSub client-connection transport。
3. Standalone sidecar worker lifecycle。
4. Client SDK create session and assignment。
5. Sidecar Copilot process-wrapper event loop。
6. Queued session scheduler and idle pause policy。
7. Docker WorkerPool scale loop。
8. Durable session memory across worker recycle（pause+capture 与 resume+restore 合并）。
9. Local worker type（worker-type-driven adapter binding 与 copilot-managed-local persistence）。
10. Durable interaction broker（approval 与 client tool round-trip，Copilot pending-request 桥接成 central-owned durable interaction）。
11. Reconnect and replay。
12. Thin auth and audit boundary。

前六个 slices 跑通后，POC 已经形成可交互主线和基本 lifecycle reconciliation：Client SDK 能创建 session，central 能把同一个 session 的多轮 input 路由到 registered Worker 上的 running Copilot-backed agent runtime，并把回复持久化后推回 Client SDK；queued session 会在 Worker ready 后被主动分配，idle session 会按 AgentSpec policy 进入 paused，client open/history 不会隐式唤醒 session。Docker WorkerPool scale loop 在这条主线之后接入，验证 WorkerPool 只是 capacity source 和 host 操作 owner，不改变 Worker registration、selection、assignment、event loop 的统一路径。

## 16. Validation Commands

每个 slice 完成后都运行：

```powershell
pnpm build
pnpm typecheck
pnpm test
```

新增测试要放在对应 runtime 行为附近，命名以 `scenario:` 开头。测试断言 public outcome：session file、event log、worker record、published group event、snapshot directory、restored volume content。不要测试私有 helper 形状。

Slice 3 必须包含真实 Web PubSub e2e integration test，覆盖 standalone sidecar 从 central URL、tenant id 和显式 worker registration body 启动、调用 central `/sidecar/negotiate`、central 创建 WorkerRecord 并返回 `workerId`、sidecar 连接 Web PubSub、订阅 worker commands、publish 首个 heartbeat、central 写入 active Worker record。缺少 `WEBPUBSUB_ENDPOINT` 时测试 skip；环境可用时该 e2e 是必跑验证项。

Slice 4 必须包含真实 Web PubSub e2e integration test，覆盖 Client SDK 从 central URL 和 tenant id 启动、生成 client 启动级随机 `clientConnectionId`、调用 central `/client/negotiate`、连接 Web PubSub、join tenant client inbox 和 client private inbox、publish `session.create.requested`、central 写入 session truth、central 选择 registered Worker、worker commands runtime channel 收到 `session.assign`。Public protocol 变化必须同步 `sdk/client/public-protocol-spec-ch.md`、SDK code、runtime handlers、e2e tests。

Slice 5 必须包含 deterministic agent process adapter scenario test，覆盖 sidecar 收到 `session.assign` 后准备 workspace/session state 目录、把 resolved runtime config 传给 `agentProcessAdapter`、启动 Copilot SDK agent session、报告 running、处理同一 session 的两轮 input/output、为每轮发布 explicit `turn.completed`，并拒绝 stale session lease command。真实 smoke test 必须走 GitHub Copilot SDK agent session；缺少 Copilot runtime/auth 配置时 skip。

Slice 6 必须包含 session lifecycle reconciler scenario tests，覆盖 queued session 在 Worker ready 后无需 client 连接即可被 assignment、idle queued session 进入 paused 且不再自动 assignment、idle running session pause 后释放 Worker lease、client pause 释放 Worker 并让另一个 queued session 获得 assignment、client open/history 不刷新 `lastEventUpdatedAt`、resume 刷新 activity 并把 paused session 放回 queued。Sample webclient 验证必须覆盖打开 paused session 只读 history/status，点击 Pause 后进入 pausing/paused，以及点击 Resume 后 session 回到 queued/starting/running 路径。

Slice 7 必须包含真实 Docker validation。先 build `containers/sidecar/Dockerfile`，再在 Windows host 上 mount 本机 Azure CLI profile 到 container `/home/sidecar/.azure`，设置 `AZURE_CONFIG_DIR=/home/sidecar/.azure`，验证 container 内 `az account show`、`az account get-access-token --scope https://cognitiveservices.azure.com/.default` 和 Node `DefaultAzureCredential().getToken('https://cognitiveservices.azure.com/.default')` 都成功。随后用同一个 image 跑 WorkerPool scale out/in e2e：queued session 触发 Docker hostPoolAdapter 启动 sidecar container，sidecar 使用标准 `/sidecar/negotiate` 注册 Worker，assignment 和至少一轮 input/output event loop 成功，Worker idle 达到 `scaleInIdleMs=5000` 后 WorkerPool controller 调用 Docker hostPoolAdapter stop/remove container。Docker 或本机 `az login` 不可用时不能声明 Slice 7 完成。

Slice 8 必须包含 in-process continuity scenario test 和真实 Docker continuity e2e。In-process test 用真实 SidecarDaemon、真实 central runtime、in-memory runtime transport，以及一个把会话记忆写进 agent session state 目录的 deterministic agent process adapter；它用两个共享同一个 session-addressed snapshot 区、但各自独立 work root 的 sidecar 模拟 Worker 回收，断言 pause 后 snapshot 区的 `parts/workspace` 含写入文件、resume 后新 Worker 的 workspace 含恢复文件、第二轮能读回该文件并续接记忆。真实 Docker continuity e2e 在 Slice 7 的 WorkerPool 主线上扩展：第一轮让 Copilot 在 workspace 写文件，pause 触发 capture 与 scale-in 回收 Worker，resume scale 出新 Worker 并 restore，第二轮 Copilot 通过 `resumeSession()` 续接并读回文件。Docker 或本机 `az login` 不可用时该 e2e skip，但 in-process continuity scenario test 必须随每次构建运行并通过。

Slice 9 必须包含 worker-type binding scenario test 和 local agent assignment scenario test。前者断言 sidecar 只 ref `WORKER_TYPE`，registration body 的 sidecarClass/labels/capacity 全部来自 worker type registry，且实例化的是 type 注册的 local workspace adapter 与 Copilot process adapter；后者用真实 central runtime + in-memory runtime transport，断言 `copilot-local` session 选中 local worker、不调用 host pool adapter、单 worker 承载多 session、pause 释放一个 capacity 槽且不写 snapshot、resume 走 queued→assign 回到同一 worker 且 assign 不带 restore ref。真实 local Copilot smoke test 用 `WORKER_TYPE=copilot-local` 起本机 worker 并完成一轮 input/output；缺少 Copilot runtime/auth 配置时 skip。

Slice 10 必须包含 interaction broker scenario tests，覆盖：approval interaction 在无 client 订阅时持久化并在 response 后续接 turn、并行两个 `tool_call` interaction 按 `interactionId` 独立 resolve 且不 head-of-line 阻塞 worker command 入站、agent-executed built-in/MCP tool 保持 observation 不产生 interaction、`scope: session` 的 approve 建立 gate rule 后同类 gated action 在 gate 自动放行且不产生 interaction/不往返 client、open interaction 跨 pause/resume 持久、未授权 principal 的 `interaction.respond.requested` 被 central 拒绝且不产生 `session.interaction.response`。真实 Copilot smoke test 必须让 Copilot 产生真实 permission request 并通过 pending-permission RPC 用 central-routed response 完成 approval，并验证 `scope: session` 让 Copilot 记下 session rule、后续同类请求不再 surface；缺少 Copilot runtime/auth 配置时 skip。Public protocol 变化必须同步 `sdk/client/public-protocol-spec-ch.md`、SDK code、runtime handlers、e2e tests。