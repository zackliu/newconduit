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
6. SDK 是客户侧代码，放在 `sdk/`，不 import `src/`。`src/` 是服务提供商 runtime implementation；SDK 只按 `sdk/public-protocol-spec-ch.md` 实现 public protocol。
7. Public protocol 变化必须同步更新 `sdk/public-protocol-spec-ch.md`、SDK 类型、central/sidecar public protocol 处理、e2e tests。
8. Worker 是注册进 tenant runtime 的可用 capacity。实现计划先用 standalone sidecar direct registration 验证 Worker lifecycle contract，再接入 POC 的 Docker WorkerPool controller/adaptor provisioned registration；注册成功后都进入同一套 Worker registry contract。Standalone path 是验证 wedge，不是新的 hosting model。
9. Worker selection 只使用 AgentSpec selector 与 Worker record 上的 `sidecarClass`、labels、capacity、conditions；不按 standalone、Docker、WorkerPool source 分叉。
10. Worker registry 必须区分 active Worker 和历史/tombstone record。只有 active、ready、allocatable 的 Worker 能被 selection；closed、expired、disconnected、draining 且无可分配容量的 Worker 都不能被分配新 session。
11. 先跑通 standalone sidecar worker、Client SDK create session、assignment、Copilot process-wrapper、多轮 session event loop、queued session scheduler 和 idle pause policy，再接入 WorkerPool provisioning 和 WorkerCapacityScaler。
12. Agent session history 由具体 agent adapter 自己的 state files 承载；POC 通过 sidecar-managed agent session state directory/volume 验证 process-wrapper 行为，通过 Docker volume snapshot/restore 保留这些文件。Event cursor、event log 和 snapshot marker 仍由 central-owned storage 表达，sidecar-local metadata 不作为 session truth。
13. 每个 slice 的测试都用 scenario 名字描述系统结果。
14. 不为 POC 添加 crash recovery、Kubernetes、完整 auth matrix、非 Web PubSub transport。
15. Session lifecycle status 与 client connection/subscription 独立。Client connect、open、list、history replay 和 attach session events 不刷新 session activity，也不改变 session status；只有 create、input、resume、pause、agent/status output 等 session-scoped durable events 才刷新 session 的 `lastEventUpdatedAt`。

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

目标：先不依赖 WorkerPool provisioning 和 WorkerCapacityScaler，手动启动一个 standalone sidecar，让它作为 Worker 运行实体通过同一个 Worker lifecycle contract 注册、首个 heartbeat 后进入 ready、持续保活、drain/evacuate/close、以及过期摘除。这个 slice 要把 Worker 作为可用 capacity 的完整生命周期做好，而不是只证明一次 register 成功。

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
- WorkerCapacityScaler 未参与本 scenario。

Expect：

- Central 分配 `workerId`。
- Worker record 的 `sidecarClass` 是 `copilot-process-wrapper`。
- Worker labels 包含 `agent=copilot`。
- Register 后但首个 heartbeat 前，Worker 不在 ready selection path。
- 首个 heartbeat 后，Worker capacity/allocatable 是 1，condition 是 `ready`，并进入和后续 WorkerPool provisioned Worker 相同的 selection path。
- Central 不调用 WorkerPool controller/adaptor，也不调用 WorkerCapacityScaler。

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
- `sdk/public-protocol-spec-ch.md` 记录 SDK 依赖的 public REST endpoint、query、runtime channels、event types、payload schemas、Web PubSub group 语义。
- SDK public API：`connect`、`sessions.start`、`sessions.open`、`SessionHandle.send`、`AgentTurn.events`、`AgentTurn.waitForResult` 的 POC 版本。
- SDK REST path：`POST /client/negotiate?tenantId=<tenantId>&clientConnectionId=<client-startup-random-string>`。
- SDK Web PubSub path：connect 后 publish `session.create.requested` 到 tenant inbox runtime channel。
- SDK 内部持有自己的 public protocol types，按 `sdk/public-protocol-spec-ch.md` 对齐，不从 `src/shared` import。
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
- WorkerCapacityScaler 未参与本 scenario。

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

- `sdk/public-protocol-spec-ch.md` 已定义 SDK 使用的 REST endpoint、query、runtime channels、event types、payload schemas。
- SDK 源码、central public handlers、sidecar public handlers 已存在。

Expect：

- SDK 不 import `src/`。
- SDK public event type、payload shape、REST path、query key 与 `sdk/public-protocol-spec-ch.md` 一致。
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

- AgentSpec 增加 `idlePauseTimeoutMs`，由 admission manager 解析为 resolved AgentSpec runtime policy。POC 静态 AgentSpec 默认值是 `60000`。
- `SessionRecord` 增加 `lastEventUpdatedAt`。`session.created` 写入时初始化该字段；`input.accepted`、`agent.output`、`turn.completed`、`turn.failed`、`status.changed`、`session.pause.requested`、`session.paused`、`session.resume.requested`、`session.resumed` 等 session-scoped durable events 写入后刷新该字段。
- Client connect、`sessions.open(sessionId)`、`sessions.list()`、`session.history()`、session events subscribe/replay 不刷新 `lastEventUpdatedAt`，也不改变 session status。
- Tenant runtime 增加 session lifecycle reconciler。Central 周期性运行该 reconciler；Worker register 或 heartbeat 让 Worker 进入 ready selection path 后，central 立即运行同一个 reconciler 一次。
- Reconciler 扫描当前 tenant 的 session。`queued` 且 `now - lastEventUpdatedAt < idlePauseTimeoutMs` 的 session 进入 assignment workflow；matching ready Worker 存在时写入新的 `sessionLeaseId` 和 `currentWorkerId`，status 变为 `starting`，并 publish `session.assign`。
- `queued` 且 `now - lastEventUpdatedAt >= idlePauseTimeoutMs` 的 session 进入 `paused`，append `session.paused`，reason 是 `idle_timeout`。Paused session 不会被 reconciler 主动 assignment。
- `running` 且 `now - lastEventUpdatedAt >= idlePauseTimeoutMs` 的 session 进入 central-initiated pause：central append `session.pause.requested`，reason 是 `idle_timeout`，status 变为 `pausing`，并向当前 Worker publish pause command。Sidecar 在 turn boundary 停止接收新 input、flush agent state，然后 ack pause；central append `session.paused`，清空 `currentWorkerId` 和 `sessionLeaseId`，释放 Worker capacity。Slice 9 再把这个 pause boundary 扩展为 Docker volume snapshot；本 slice 的完成条件是 durable event boundary、status truth 和 worker lease release 正确。
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

## 9. Slice 7：Docker WorkerPool Provisioning

目标：在 standalone sidecar worker 闭环已经跑通后，增加一个 POC Docker WorkerPool controller/adaptor。它负责 provision sidecar，但 provision 出来的 sidecar 仍然通过同一个 `/sidecar/negotiate` registration contract 成为普通 Worker。

实现范围：

- POC Docker WorkerPool record/config。
- Docker WorkerPool controller/adaptor 启动 sidecar container。
- Sidecar container 使用 `/sidecar/negotiate` 注册 Worker 并连接 Web PubSub。
- Docker workspace volume。
- Docker Copilot session volume。
- WorkerPool source/provisioning metadata 不进入 Worker selection 条件。

Scenario-based test：`scenario: docker worker pool provisions a worker using the same registration contract`

Given：

- POC Docker WorkerPool controller/adaptor 启动 sidecar container。
- Container 内 sidecar 使用与 standalone sidecar 相同的 registration、assignment 和 Copilot process-wrapper contract。

Expect：

- Sidecar container 通过 `/sidecar/negotiate` 注册 Worker。
- Central 分配 `workerId`。
- Worker record shape 与 standalone sidecar 注册出的 Worker 一致。
- Worker record 的 `sidecarClass` 是 `copilot-process-wrapper`。
- Worker labels 包含 `agent=copilot`。
- Worker capacity/allocatable 是 1。
- Worker condition 是 `ready`。
- Worker selection 不使用 Docker container id，也不使用 WorkerPool source。
- Session assignment 后，sidecar 使用 Docker workspace volume 和 Copilot session volume 启动 Copilot-backed agent runtime。
- 该 Worker 能完成至少一轮 input/output event loop。

## 10. Slice 8：WorkerCapacityScaler Uses WorkerPool

目标：只有在 standalone sidecar worker 和 Docker WorkerPool provisioned Worker 都已验证后，WorkerCapacityScaler 才负责在没有 matching ready Worker 时调用 matching WorkerPool controller/adaptor provision 新 Worker。

实现范围：

- WorkerCapacityScaler。
- WorkerPool registry/controller selection。
- Docker WorkerPool controller/adaptor integration。
- create/queued 后的 capacity ensure path。
- WorkerCapacityScaler 只负责 provision matching Worker capacity；queued session assignment 继续由 Slice 6 的 session lifecycle reconciler 执行。

Scenario-based test：`scenario: queued session causes scaler to provision a worker from matching worker pool`

Given：

- Session status 是 `queued`。
- Worker registry 中没有 matching ready Worker。
- AgentSpec `workerSelector` 需要 `agent=copilot`。
- POC Docker WorkerPool 声明它能 provision `sidecarClass=copilot-process-wrapper`、`labels.agent=copilot` 的 Worker。

Expect：

- WorkerCapacityScaler 选择 matching WorkerPool 并调用其 controller/adaptor provision sidecar。
- Provisioned sidecar 注册 ready Worker。
- Provisioned Worker ready 后，Slice 6 的 session lifecycle reconciler 把 queued session assignment 给新 Worker。
- Session status 变为 `starting`，随后在 sidecar 启动 Copilot 后变为 `running`。
- Worker selection 仍然只看注册后的 Worker record，不走 WorkerPool 旁路匹配路径。
- Client SDK 仍然只面向 session 通信，不知道 WorkerPool、Docker container、Worker endpoint。

## 11. Slice 9：Pause Session With Volume Snapshot

目标：基于 Slice 6 的 pause lifecycle，Running session 进入 paused 时生成同一 event boundary 下的 workspace volume snapshot 和 Copilot session volume snapshot。

实现范围：

- Slice 6 已建立的 `session.pause.requested` handling、`running -> pausing -> paused` status truth、pause command 和 turn-boundary pause。
- Copilot session files flushed to Copilot session volume。
- Snapshot controller。
- Docker volume adapter。
- Snapshot marker event。
- Worker lease release。

Scenario-based test：`scenario: pause creates aligned workspace and Copilot session volume snapshots`

Given：

- Session status 是 `running`。
- Workspace volume contains a test workspace file。
- Copilot session volume contains a test session file。
- Client SDK publish `session.pause.requested` 到 tenant inbox runtime channel。

Expect：

- Central append `pause.requested`。
- Session status 变为 `pausing`。
- Sidecar receives pause command。
- Snapshot controller 在同一 event boundary 上调用 Docker volume adapter 复制 workspace volume 到 snapshot directory。
- Snapshot controller 在同一 event boundary 上调用 Docker volume adapter 复制 Copilot session volume 到同一个 snapshot directory。
- Snapshot metadata `baseEventCursor` matches event boundary。
- Central append `snapshot.created` marker event。
- `latestSnapshotRef` is updated。
- Worker lease is released。
- Session status 变为 `paused`。

## 12. Slice 10：Resume Session From Volume Snapshot

目标：Paused session resume 后先回到 queued，再通过统一 assignment path 恢复 workspace volume 和 Copilot session volume，重启 Copilot，并回到 running。

实现范围：

- `session.resume.requested` handling。
- Recovery controller planned resume path。
- WorkerPool capacity ensure。
- Docker volume adapter restore。
- Worker lease assignment。
- Sidecar starts Copilot after restore。
- Session status `paused -> queued -> starting -> running`。

Scenario-based test：`scenario: resume restores volumes before starting Copilot`

Given：

- Session status 是 `paused`。
- Latest snapshot contains workspace and Copilot session volume copies。
- Client SDK publish `session.resume.requested` 到 tenant inbox runtime channel。

Expect：

- Central append `session.resume.requested`，刷新 `lastEventUpdatedAt`，并把 session status 变为 `queued`。
- Central reads latest snapshot。
- Docker volume adapter restores workspace volume。
- Docker volume adapter restores Copilot session volume。
- Restored workspace volume contains expected file。
- Restored Copilot session volume contains expected session file。
- Central writes a new `sessionLeaseId`。
- Sidecar starts Copilot after restore completes。
- Central append `session.resumed`。
- Session status 变为 `running`。

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
7. Docker WorkerPool provisioning。
8. WorkerCapacityScaler uses WorkerPool。
9. Pause with volume snapshot。
10. Resume from volume snapshot。
11. Reconnect and replay。
12. Thin auth and audit boundary。

前六个 slices 跑通后，POC 已经形成可交互主线和基本 lifecycle reconciliation：Client SDK 能创建 session，central 能把同一个 session 的多轮 input 路由到 registered Worker 上的 running Copilot-backed agent runtime，并把回复持久化后推回 Client SDK；queued session 会在 Worker ready 后被主动分配，idle session 会按 AgentSpec policy 进入 paused，client open/history 不会隐式唤醒 session。WorkerPool provisioning 和 WorkerCapacityScaler 在这条主线之后接入，验证它们只是 capacity source，不改变 Worker registration、selection、assignment、event loop 的统一路径。

## 16. Validation Commands

每个 slice 完成后都运行：

```powershell
pnpm build
pnpm typecheck
pnpm test
```

新增测试要放在对应 runtime 行为附近，命名以 `scenario:` 开头。测试断言 public outcome：session file、event log、worker record、published group event、snapshot directory、restored volume content。不要测试私有 helper 形状。

Slice 3 必须包含真实 Web PubSub e2e integration test，覆盖 standalone sidecar 从 central URL、tenant id 和显式 worker registration body 启动、调用 central `/sidecar/negotiate`、central 创建 WorkerRecord 并返回 `workerId`、sidecar 连接 Web PubSub、订阅 worker commands、publish 首个 heartbeat、central 写入 active Worker record。缺少 `WEBPUBSUB_ENDPOINT` 时测试 skip；环境可用时该 e2e 是必跑验证项。

Slice 4 必须包含真实 Web PubSub e2e integration test，覆盖 Client SDK 从 central URL 和 tenant id 启动、生成 client 启动级随机 `clientConnectionId`、调用 central `/client/negotiate`、连接 Web PubSub、join tenant client inbox 和 client private inbox、publish `session.create.requested`、central 写入 session truth、central 选择 registered Worker、worker commands runtime channel 收到 `session.assign`。Public protocol 变化必须同步 `sdk/public-protocol-spec-ch.md`、SDK code、runtime handlers、e2e tests。

Slice 5 必须包含 deterministic agent process adapter scenario test，覆盖 sidecar 收到 `session.assign` 后准备 workspace/session state 目录、把 resolved runtime config 传给 `agentProcessAdapter`、启动 Copilot SDK agent session、报告 running、处理同一 session 的两轮 input/output、为每轮发布 explicit `turn.completed`，并拒绝 stale session lease command。真实 smoke test 必须走 GitHub Copilot SDK agent session；缺少 Copilot runtime/auth 配置时 skip。

Slice 6 必须包含 session lifecycle reconciler scenario tests，覆盖 queued session 在 Worker ready 后无需 client 连接即可被 assignment、idle queued session 进入 paused 且不再自动 assignment、idle running session pause 后释放 Worker lease、client pause 释放 Worker 并让另一个 queued session 获得 assignment、client open/history 不刷新 `lastEventUpdatedAt`、resume 刷新 activity 并把 paused session 放回 queued。Sample webclient 验证必须覆盖打开 paused session 只读 history/status，点击 Pause 后进入 pausing/paused，以及点击 Resume 后 session 回到 queued/starting/running 路径。