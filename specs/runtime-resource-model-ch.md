# Runtime Resource Model Spec：用 Workflow 校验 Class 与 Controller

状态：架构讨论稿  
读者：架构师、runtime owner、controller owner、API/SDK owner、sidecar owner

## 1. 目的

这份 spec 定义 Agent Runtime Sidecar 的 resource classes、controller 行为和可替换边界。它不再从静态分类表开始，而是先用一条几乎覆盖 V1 全部能力的 workflow 来串联所有资源、class reference、controller 和 adapter。

这条 workflow 从 AgentSpec 定义和 class 注册开始，经过 session 创建、worker capacity scale-out、Worker 注册、session 运行、pause、resume，再到 Worker crash 后 restore session。这样写的目标是让资源模型接受一个更强的校验：

1. 如果 workflow 里需要一个 durable fact，却没有任何 resource 承接，说明模型漏了。
2. 如果一个 resource 或 controller 在完整 workflow 里没有被读写或决策，说明它可能不是 V1 必需对象。
3. 如果某个 controller 不拥有明确输入、输出和 invariant，它应该只是内部模块、adapter 或部署细节，而不是规格层面的 controller class。
4. 如果某个可替换点会绕过 session truth、event log、worker lease、authorization 或 audit，它就不是合法替换点。

这份文档仍然借鉴 Kubernetes 的组织方式：AgentSpec 类似 workload template，Worker 类似 Node，controller 通过 watch/list/reconcile 驱动状态变化。但本系统的 durable object 是 Session，不是 pod。Worker 是被 sidecar daemon 注册进 runtime 的 replaceable compute resource，不是 workload 定义，也不是 client-facing endpoint。

## 2. Scenario 边界

本文使用一个具体但可泛化的 scenario：

- tenant `t-acme` 的 application backend 要把一个 coding/developer-tool agent 作为 online service 提供给用户。
- agent 已经能作为 CLI 或本地 process 启动；V1 通过 process-wrapper sidecar 接入它，而不是要求它改写成新 agent framework。
- worker pool 是同质化的：可用 Worker 都能运行同一个 AgentSpec 或可验证兼容的 AgentSpec resolved copy。
- session 是 workspace-heavy、long-running、interactive 的：它会读写 workspace，产生 tool event，等待 approval，允许用户 pause/resume，也可能遇到 worker crash。
- V1 的恢复基础是 event log、workspace snapshot，以及被 AgentSpec 声明为可持久化的 agent session state。true continuation 可以由 adapter 声明支持，但 baseline 是 restart with context。缺少恢复材料时必须暴露 non-recoverable failure。

这个 scenario 明确不要求 V1 成为 model provider、完整 agent framework、hosting platform、marketplace、full management UI、general application builder 或跨个人设备/边缘设备的异构调度系统。

## 3. Workflow 总览

完整 workflow 可以压缩成下面的事实链：

```text
AgentSpec + class/profile admission
        |
        v
Create durable Session before any Worker is guaranteed
        |
        v
No compatible Worker -> emit desired capacity
        |
        v
Hosting platform starts compute -> sidecar registers Worker
        |
        v
Worker selection writes current worker lease/generation
        |
        v
Sidecar prepares workspace and starts agent process
        |
        v
Client input, agent output, tool/approval/status events flow through event log
        |
        v
Snapshot controller aligns workspace snapshot with event cursor
        |
        v
Pause session -> snapshot -> release or park worker lease
        |
        v
Resume session -> select Worker -> restore workspace -> restart or continue
        |
        v
Worker crash -> heartbeat/lease failure -> recovery controller restores or fails explicitly
```

这条链路里，central service 是 session-facing control plane 和 communication entry point。Sidecar daemon 是 compute 内部的 runtime adapter。Central service 和 sidecar 之间的连接方式是 runtime/deployment 级统一配置，可以由 long-poll、WebSocket、broker、gRPC stream 或其他 adapter 实现，但不能进入 AgentSpec。Persistent storage 保存 session catalog、worker registry state、event log、workspace snapshot metadata、agent session state metadata 和 audit records。Hosting platform 只负责 provision compute capacity，不拥有 session identity、recovery semantics 或 client routing contract。

## 4. 完整 Scenario

### 4.1 定义 AgentSpec 和 class/profile

Scenario 从 application owner 或 platform admin 注册一个 AgentSpec 开始。AgentSpec 不是正在运行的 agent instance，而是“这种 agent 如何被启动、需要什么环境、能用什么工具、如何恢复”的声明式定义。

请求中至少包含：

- `agentSpecId`，例如 `repo-coder`。
- `launch`，例如 image、command、process-wrapper 参数或 agent harness 入口。
- `labels`，AgentSpec 自身的任意 key/value metadata，用于 policy、capacity profile 或 Worker 支持范围选择。
- `sidecarClass`，指定哪类 sidecar daemon/agent adapter 能解释该 spec，默认可以是 `default`。
- `workspaceClass`，指定 workspace prepare、snapshot、restore 的 class，默认可以是 `default`。
- `toolClass` 或 `toolProfile`，指定 tool、MCP、skills、secret/config 注入方式。
- `workerSelector`，Kubernetes-style label selector，只匹配 Worker labels，例如 `matchLabels` / `matchExpressions`；selector schema 不固定 OS、runtime、network、GPU 等条件名。
- `pausePolicy`，声明 planned pause 的默认模式、safe boundary、snapshot 要求、lease 释放或保留策略，以及 pause 失败时的状态处理。
- `recoveryPolicy`，声明支持 true continuation、restart with context、non-recoverable 中哪些模式，以及默认恢复偏好。
- `agentStatePolicy`，声明 Codex/Copilot 等 agent 私有 session 文件、checkpoint 文件或 adapter export 如何 capture/restore，以及缺失时是否降级。
- `version` 或 `digest`，用于让 session creation 冻结 resolved meaning。

AgentSpec admission controller 负责校验必需字段、注入默认 class/profile、解析 class registry，并生成 resolved AgentSpec copy 或 stable reference。Authorization controller 作为 runtime 边界上的可插入决策模块保留；具体哪些 AgentSpec action 需要检查，由后续 auth/audit spec 定义。Audit controller 记录后续 auth/audit spec 确定为安全关键的 admission、policy decision 和 class/profile resolution 事实。

这里的 `sidecarClass`、`workspaceClass`、`toolClass/toolProfile` 是 class reference 或 profile reference，不是一段由 central service 直接执行的业务逻辑。Central service 只需要理解它们对 admission、worker matching 和 recovery 的公共语义；具体 adapter 行为留在 sidecar、workspace storage、tool/MCP adapter 或客户配置里。

所有 selector 都采用 label selector 语义。`workerSelector` 只选择 Worker labels。Labels 可以有 runtime 约定 key 和客户自定义 key，但 selector 字段本身不固定某种 OS、GPU、network、repo access 等条件名。

这一阶段的 invariant 是：Session 创建时必须能绑定 AgentSpec reference 或 resolved copy，不能只保存一个未来含义可能漂移的名字。否则 resume 和 crash recovery 会依赖当前 registry 状态，而不是 session 创建时的 durable contract。

### 4.2 创建 Session，即使还没有 Worker

用户或 application backend 请求创建一次 session。请求带上 tenant、principal、AgentSpec、owner、participants 或 accessPolicyRef、initial input、initial workspace 约束。

Central service 先经过 authorization boundary；本 resource model 不固定完整 action matrix，只要求 session 创建这种进入 runtime 的边界能接入 policy decision 和 audit。Decision 允许后，Session lifecycle controller 创建 session record，写入 creation event，并初始化 workspaceRef、eventCursor、accessPolicyRef 和 lifecycle status。

此时即使没有任何 compatible Worker，session record 也必须已经存在。它可以进入 `queued`，并带上 `waitingForCapacity` 之类的 lifecycle reason。初始用户输入应该作为 event log 中的 durable input event，而不是只挂在 create request 的 transient memory 上。

这一阶段写入的 truth 包括：

| Truth | 写入方 | 为什么必须在 Worker 前存在 |
| --- | --- | --- |
| Session record | Session lifecycle controller | session ID 是 durable identity，不能依赖 worker 启动成功。 |
| Resolved AgentSpec | AgentSpec admission controller + Session lifecycle controller | 后续 worker matching、resume、restore 都必须使用同一份含义。 |
| Creation/input event | Event log controller | reconnect、audit、recovery 都需要知道 session 为什么存在、第一条输入是什么。 |
| Access policy/audit fact | Authorization + Audit controller | session 一创建就进入治理边界，不能等到开始运行后再补模块。 |
| WorkspaceRef | Session lifecycle controller | workspace state 的身份和存储位置要跟 session identity 绑定。 |

这一阶段的 invariant 是：create session 不等于已经有 agent process 在跑。Session 是 durable work identity；agent process 只是未来某个 Worker 上的 execution projection。

### 4.3 没有 Worker 时 scale out capacity

Worker selection controller 读取 queued sessions、resolved AgentSpec、tenant/capacityScope、policy 和 Worker registry。如果没有 ready 且 capacity 足够的 compatible Worker，它不应该让 create session 失败，也不应该把 client 引导到某个 hosting endpoint。它应该把 session 保持在 queued，并让 Worker capacity scaler 看到 backlog。

Worker capacity scaler 读取 pending sessions、available worker capacity、sidecarClass、workerSelector、tenant/capacityScope 和 hosting backend 配置，输出 desired compute capacity。Hosting adapter 把这个 desired capacity 转成当前 hosting backend 的具体动作。

Hosting platform 启动 compute 后，sidecar daemon 才开始运行。Sidecar 使用运行时 credential 向 central service 注册 Worker，声明：

- `capacityScope`，来自 tenant runtime。
- `workerId` 由 central 在 registration lifecycle 内分配；hostname、pod name、container id 等运行环境名称只作为 labels 或 diagnostic metadata。
- `sidecarClass`。
- labels，使用任意 key/value 表达 placement、diagnostic 和客户自定义属性。
- `capacity` / `allocatable`。
- conditions，例如 ready、draining、unhealthy、disconnected。
- heartbeat/status report。

Worker registry controller 校验 registration credential、capacity scope 和最小注册字段，然后创建 Worker resource。Authorization controller 保留为 worker registration 边界的 policy hook；Audit controller 记录后续 auth/audit spec 认定为安全关键的 worker registration、registration credential failure 和 capacity scope 变化。

这一阶段的 invariant 是：hosting object 不是 Worker。只有 sidecar 注册并通过 central service 认证后，底层 compute 才成为 runtime 里的 Worker resource。Worker 也不是 session identity；它只是可替换 capacity。

### 4.4 选择 Worker，写入 lease，然后启动 agent

Worker registry 出现 ready Worker 后，Worker selection controller 重新 reconcile queued session。它根据 resolved AgentSpec、`sidecarClass`、`workerSelector` 对 Worker labels 的匹配结果、capacity、tenant/capacityScope、conditions 和 policy 选择 compatible Worker。

Session lease controller 在 session record 中写入 `currentWorkerId` 和 `sessionLeaseId`，并更新 Worker 的 capacity accounting。Session lifecycle controller 把 session 状态推进到 `starting`。Sidecar 通过 worker command channel 接收 session assignment，assignment 包含 sessionId、tenant、workerId、sessionLeaseId、resolved AgentSpec、workspaceRef、latestSnapshotRef、event cursor 和必要 runtime config。

Sidecar 收到 lease 后做三件事：

1. 通过 workspace adapter 准备 workspace：创建目录、拉取初始文件、恢复 snapshot 或写入 runtime config。
2. 通过 agent adapter 按 AgentSpec launch 启动或 attach 到 agent process，并按 `agentStatePolicy` 注入或恢复 agent 私有 session state。
3. 把 workspace prepared、agent started、agent ready 等状态转成 runtime events 或 status report。

Event projection controller 从 event log 推导 activity，例如 processing、idle、awaiting input、awaiting approval、error。Session lifecycle controller 在 agent ready 后把 session 推进到 `running` 或 `awaitingInput`。

这一阶段的 invariant 是 session lease fencing。Sidecar 向 central service 写 event、status 或 snapshot metadata 时，必须携带当前 `sessionLeaseId`。Central service 必须拒绝旧 lease 或未知 lease 的写入，防止 crash、network partition 或 delayed sidecar 继续写同一个 session。

### 4.5 运行 interactive session

Client 连接 session 时只面向 central service。Central service 经过 authorization boundary 后返回 session snapshot、当前 lifecycle/status、event cursor，并通过 Event transport adapter 从 cursor replay 或继续 stream。Client 不需要知道 active Worker endpoint。

用户发送 input、approval、cancel 或 correction 时，central service 先经过 authorization boundary，再通过 Event log controller append event。Append 成功后，Sidecar connection adapter 把增量送到当前 worker lease 对应的 sidecar；具体 transport 可以替换。Sidecar 把 runtime event 转成 agent process 可理解的 stdin、本地 HTTP/gRPC、SDK callback 或其他 local IPC。

Agent process 产生 output、tool call、tool result、permission request、status、error 或 checkpoint signal。Sidecar agent adapter 把这些事实翻译成 runtime event，并通过 sidecar API append 到 event log。需要用户参与的 approval 不能只存在于 worker 内存里的 pending promise：permission request 必须成为 event log 中的 durable event，client 的 approval/deny 也必须成为 event；是否需要授权、如何审计由后续 auth/audit spec 定义。

Snapshot controller 按 lifecycle、checkpoint signal、event boundary 或时间策略触发 workspace snapshot。Sidecar agent adapter 根据 `agentStatePolicy` 先把 agent 私有 session 文件或 checkpoint export 到 snapshot staging area；Workspace storage adapter 保存 workspace state 和 agent session state，返回 snapshot metadata。Snapshot controller 再写 snapshot marker event，使 `latestSnapshotRef`、agent state metadata 和 event cursor 对齐。

这一阶段的 truth 和 projection 要分开：

| 对象 | Truth 位置 | 说明 |
| --- | --- | --- |
| 输入、输出、tool、approval、status、error | Append-only event log | transport 可以丢失或重连，event log 才是 replay truth。 |
| activity/status summary | Event projection + session record | projection 可以重建，不能成为唯一 truth。 |
| workspace 文件和中间产物 | workspace state + snapshot storage | worker-local disk 只是当前投影，snapshot 才是恢复边界。 |
| agent 私有 session 文件 | agentStatePolicy + snapshot metadata + persistent storage | Codex/Copilot 等 agent 的 session 文件由 adapter capture/restore，不由 central service 解释文件格式。 |
| workspace output access | workspace metadata/event reference + authorization/audit boundary | V1 不单独引入 output resource；具体访问动作由后续 auth/audit spec 定义。 |
| 安全关键访问 | audit log | 哪些访问属于安全关键路径由后续 auth/audit spec 定义；一旦被定义，就不能只依赖普通 debug log 或异步 listener。 |

这一阶段的 invariant 是：routing、replay、workspace output access、approval 和 cancel 都发生在 session governance boundary 内，但本 resource model 不冻结具体 authorization action matrix。Event stream 是实时传输方式，不是 source of truth。

Agent 私有 session state 不单独成为 V1 resource。它属于 WorkspaceSnapshot 的一部分，由 `agentStatePolicy` 决定 capture/restore 方式。Snapshot controller 负责在 event boundary 上编排 capture；sidecar agent adapter 负责调用 Codex/Copilot 等 agent 的导出能力或收集约定路径下的 session 文件；Workspace storage adapter 负责把这些 bytes 保存到 persistent storage，并返回 `agentStateRefs`、checksum、size、format hint 等 metadata。Recovery controller 只读取 metadata 和 policy 来决定 true continuation、restart with context 或 failure；central service 不解析私有 session 文件格式。

### 4.6 Pause session

Pause 是一个显式 lifecycle action，不等同于 client disconnect。Client disconnect 只是连接状态变化；pause 表示 runtime 要把 session 带到一个可解释的停止边界，使 Worker capacity 可以被释放或保留，并让后续 resume 有明确恢复材料。

用户或 application backend 请求 pause。Central service 经过 authorization boundary 后，Session lifecycle controller 把 session 从 `running` 或 `awaitingInput` 推进到 `pausing`，Event log controller 写入 pause requested event。Control event 被路由到当前 worker lease 对应的 sidecar。

Sidecar 根据 AgentSpec 的 `pausePolicy`、`agentStatePolicy`、`recoveryPolicy` 和 agent adapter 能力尝试到达 pause boundary：

| Pause 模式 | 使用条件 | Session truth |
| --- | --- | --- |
| Durable pause | V1 baseline。Agent 可以在 turn/checkpoint 边界 graceful stop，或至少 workspace 和 agent session state 可以 snapshot。 | 写 snapshot marker，更新 latestSnapshotRef/eventCursor，释放 current worker lease，session 进入 `paused`。 |
| Parked continuation | Adapter 能安全 suspend 或保持 agent process，且产品愿意保留 Worker capacity。 | session 进入 `paused` 或 `suspended`，current worker lease 可保留，但必须有 TTL、heartbeat 和 fencing。 |
| Pause failed | Agent 无法到达安全边界，snapshot 或 checkpoint 失败。 | 写 pause failed event，session 回到 `running`、进入 `failed`，或等待 operator/user 决策。 |

V1 更适合把 durable pause 作为默认语义：pause 成功意味着 session 没有 active worker lease，Worker capacity 被释放，resume 走一条受控的 restore/restart path。这样可以更早验证 session identity 与 worker location 的分离。不同 agent 对 pause boundary、session 文件 capture、超时和失败降级的要求不同，因此 pause 策略应该由 AgentSpec 的 `pausePolicy` 声明，而不是写死在 Session lifecycle controller 里。

这一阶段的 invariant 是：pause 后旧 Worker 不能继续写 session。释放 lease 必须清空或替换 `sessionLeaseId/currentWorkerId`，并让任何迟到的 sidecar write 被拒绝。Pause 不是删除 session，也不是完成 session；event log、workspace snapshot、access policy 和 audit trail 都继续存在。

### 4.7 Resume session

用户回来后请求 resume。Central service 经过 authorization boundary 后，确认 session 处于可恢复状态，并读取 session record、resolved AgentSpec、latestSnapshotRef、event cursor、access policy、pausePolicy、agentStatePolicy 和 recoveryPolicy。

Resume 是计划内恢复。Recovery controller 判断恢复模式：

1. 如果 adapter 声明支持 true continuation，并且 workspace snapshot、agent session state 和 checkpoint 足够完整，可以尝试 true continuation。
2. 如果只有 workspace snapshot 和 event history，或 agent 私有 session state 不足以恢复内部状态，则选择 restart with context。
3. 如果缺少 snapshot、AgentSpec 不兼容、tool state 不可恢复、agent session state 缺失且 policy 不允许降级，或 policy 不允许恢复，则进入 non-recoverable failure 或保持 paused 并暴露原因。

Worker selection controller 选择 compatible Worker。如果没有 available Worker，Worker capacity scaler 再次输出 desired capacity。Session lease controller 写入新的 `currentWorkerId` 和新的 `sessionLeaseId`，Session lifecycle controller 把 session 推进到 `resuming` 或 `starting`。

新 sidecar 接收 lease 后，通过 workspace adapter 恢复 latest snapshot；通过 agent adapter 恢复 agent 私有 session 文件或 checkpoint export；通过 Event log controller 的 replay path 读取 snapshot marker 之后必要的 events；再启动 agent process、恢复 checkpoint 或把 workspace/history/context 注入 agent。恢复完成后，Event log controller 写 resume/recovery event，Session lifecycle controller 把 session 推回 `running` 或 `awaitingInput`。

这一阶段的 invariant 是：resume 仍然是同一个 sessionId，不是新建 session。Worker 可以变化，session lease 必须变化，但 session identity、owner、access policy、event log、workspaceRef 和 resolved AgentSpec 不变。SDK 可以隐藏 reconnect/stream 细节，但不能隐藏 recovery mode 和恢复降级原因。

### 4.8 Worker crash 后 restore session

Worker crash 是非计划恢复。它可能表现为 sidecar process 退出、heartbeat 超时、agent process crash、worker node 被回收、网络 partition，或 sidecar 主动上报 unrecoverable worker failure。

Worker registry controller 发现 heartbeat/status 异常后，把 Worker conditions 标记为 disconnected、unhealthy 或 draining。Worker lease controller 使 current lease 失效并执行 fencing。Session lifecycle controller 根据 affected sessions 和 recoveryPolicy，把 session 推进到 `recovering` 或 `failed`，并写 lifecycle event。Audit controller 记录 worker failure、lease expiration 和 recovery attempt。

Recovery controller 只允许从 durable facts 恢复：

1. Session record 是否存在，状态是否允许 recovery？
2. resolved AgentSpec 和 recoveryPolicy 是否允许恢复？
3. latestSnapshotRef 是否存在，snapshot marker 对应哪个 event cursor？
4. agentStatePolicy 是否要求恢复 agent 私有 session 文件？这些文件是否存在于 snapshot metadata 指向的 persistent storage 中？
5. event log 中是否存在未完成 approval、tool call、external side effect 或 snapshot failure？
6. 是否存在 compatible Worker？如果没有，是否要触发 capacity scaler？
7. sidecarClass、workspaceClass、toolProfile、workerSelector 和恢复能力是否匹配？
8. 恢复模式是 true continuation、restart with context，还是 non-recoverable failure？

如果可以恢复，Worker selection controller 选择新的 Worker，Worker lease controller 写入新的 generation，新 sidecar 恢复 workspace 和 agent session state，并启动 agent。Event log controller 写 recovery started/recovery completed event，包含 source worker、target worker、old generation、new generation、snapshot ID、agent state reference、base event cursor、recovery mode 和降级原因。

如果不能恢复，Session lifecycle controller 把 session 推进到 `failed`，保留 event log、workspace output 和 audit trail，lifecycleReason 说明缺少 snapshot、agent session state 不可用、AgentSpec 不兼容、tool state 不可恢复或 policy 拒绝。

这一阶段的 invariant 是：Worker crash 不会删除 session。未写入 durable storage 的 worker-local memory 可以丢失，但系统不能假装它已经恢复。所有恢复都必须落在 true continuation、restart with context 或 non-recoverable failure 三类语义之一。

## 5. 从 Workflow 推导出的 Resource Classes

下面的 resource class 不是先验清单，而是上面 workflow 必须读写的 durable facts。

| Resource class | 为什么 workflow 需要它 | 最小 truth / status | 主要写入方 | 被哪些步骤验证 |
| --- | --- | --- | --- | --- |
| AgentSpec | session creation、worker matching、pause/resume、crash restore 都需要同一份 agent 启动和恢复定义。 | `agentSpecId`、labels、launch、sidecarClass、workspaceClass、toolClass/toolProfile、workerSelector、pausePolicy、recoveryPolicy、agentStatePolicy、version/digest 或 resolved copy。 | AgentSpec admission controller、Session lifecycle controller。 | 4.1、4.2、4.4、4.7、4.8 |
| Session | durable agent work identity。Worker 只是当前 execution projection。 | `sessionId`、tenant、owner、participants/accessPolicyRef、resolvedAgentSpec、status、activity、currentWorkerId、sessionLeaseId、eventCursor、workspaceRef、latestSnapshotRef、createdAt/updatedAt、lifecycleReason。 | Session lifecycle controller、Session lease controller、Recovery controller、Event projection controller。 | 4.2 到 4.8 全部步骤 |
| Worker | 被 sidecar 注册进 runtime 的 replaceable compute capacity。 | `workerId`、tenant/capacityScope、sidecarClass、labels、description、capacity/allocatable、conditions、lifecycleState、heartbeatAt、expiresAt、currentSessionCount。 | Worker registry controller、sidecar daemon、Session lease controller。 | 4.3、4.4、4.7、4.8 |
| Event | session 内发生的可 replay 事实。Reconnect、approval、status projection、recovery explanation 都依赖它。 | `eventId`、sessionId、sequence/cursor、type、timestamp、actor、correlationId/causationId、payload、visibility/auditMarker、sessionLeaseId。 | Event log controller、client/backend API、sidecar API、Snapshot controller、Recovery controller。 | 4.2、4.5、4.6、4.7、4.8 |
| WorkspaceSnapshot | workspace 和 agent session state 在 event boundary 上的可恢复副本。Pause/resume 和 crash restore 都需要它。 | `snapshotId`、sessionId、baseEventCursor、storageLocation、agentStateRefs、createdAt、size/checksum、restoreHints、workspaceClass。 | Snapshot controller、Workspace storage adapter、sidecar workspace adapter、sidecar agent adapter。 | 4.5、4.6、4.7、4.8 |
| Policy/Audit | central service 是 public-facing endpoint，需要预留 authorization 和 audit 模块。 | principal、tenantId、resourceType、resourceId、action、decision、reason、correlationId、timestamp；具体 action matrix 后续定义。 | Authorization controller、Audit controller、policy hook/audit sink。 | 4.1 到 4.8 的治理边界 |

V1 不单独引入 Output resource。Workflow 里产生的 output 先落在 workspace file、event output 或 tool result 中；是否需要独立授权、审计、分享或 retention 规则，由后续 output/auth spec 判断。如果后续出现跨 session 分享、长期 retention、下载 lineage 或独立权限模型，再把 output 提升成单独 resource。

V1 也不把 `desired capacity` 建成 client-facing resource。它是 Worker capacity scaler 的输出，可以实现为 metric、queue depth、desired capacity record 或 hosting adapter call。它必须有明确 owner 和审计边界，但不应进入 Session durable identity。

## 6. Class/Profile 在层次结构里的位置

`sidecarClass`、`workspaceClass`、`toolClass/toolProfile` 容易被误解成中心服务里的可执行逻辑。它们在本模型里只是 class/profile reference，用于 admission、matching、adapter 选择和 recovery compatibility。

| Class/Profile | 被谁读取 | 决定什么 | 不决定什么 |
| --- | --- | --- | --- |
| `sidecarClass` | AgentSpec admission controller、Worker registry controller、Worker selection controller、Recovery controller、sidecar daemon | 哪类 sidecar protocol/agent adapter 能解释 AgentSpec，Worker 是否兼容。 | 不定义 session identity，不让 client 直接依赖 sidecar endpoint。 |
| `workspaceClass` | AgentSpec admission controller、Snapshot controller、sidecar workspace adapter、Recovery controller | workspace prepare、snapshot、restore 的 adapter contract。 | 不改变 workspace snapshot metadata 的最小字段和 event boundary。 |
| `toolClass` / `toolProfile` | AgentSpec admission controller、sidecar tool/MCP adapter、Authorization controller、Worker selection controller | tool、MCP、skills、secret/config 的装配 profile 和能力约束。 | 如果后续 auth spec 把 tool action 纳入治理，tool adapter 不能绕过 central authorization/audit。 |
| `workerSelector` | Worker selection controller、Recovery controller | 用 Kubernetes-style label selector 选择 Worker labels。 | 不固定 OS、runtime、network、GPU 等 selector 字段；不是新的 resource class，也不等同于 scheduler policy。 |
| `pausePolicy` | Session lifecycle controller、Snapshot controller、Recovery controller、sidecar agent adapter | planned pause 的 safe boundary、snapshot 要求、agent state capture、lease 释放或保留策略。 | 不替代 crash recovery policy，也不让 pause 成为 worker-local UI 状态。 |
| `recoveryPolicy` | Session lifecycle controller、Recovery controller、sidecar agent adapter | 恢复模式、默认偏好、可恢复边界。 | 不保证所有 agent 都能 true continuation。 |
| `agentStatePolicy` | Snapshot controller、Recovery controller、sidecar agent adapter、Workspace storage adapter | Codex/Copilot 等 agent 私有 session 文件或 checkpoint export 的 capture/restore contract。 | central service 不解释私有文件格式；persistent storage 只保存 bytes 和 metadata。 |

这些 class/profile 可以由配置文件、registry、policy hook 或未来的管理 API 提供。V1 需要稳定它们的语义和最小字段，但不需要把每个 class/profile 都建成独立 Kubernetes-style resource。

## 7. 从 Workflow 推导出的 Controller Hierarchy

Controller hierarchy 应按它们读写的事实和不可破坏的 invariant 来分层，而不是按进程拆分。一个 central service 进程可以包含多个 controller；一个 controller 也可以拆成多个内部模块。

### 7.1 不可绕过的 enforcement controllers

| Controller | 读取 | 写入/输出 | Workflow 位置 | Invariant |
| --- | --- | --- | --- | --- |
| Authorization controller | principal、tenant、resource/action、policy hook、session/AgentSpec/Worker/workspace metadata | allow/deny decision、audit input | 后续 auth/audit spec 定义的 enforcement points | authorization 模块不可绕过；policy backend 和 action matrix 可演进。 |
| Audit controller | authorization result、runtime action、correlationId、resource metadata | audit record | 后续 auth/audit spec 定义的 audit points | audit 模块不可绕过；audit sink 和具体覆盖面可演进。 |

Authorization 和 audit 不能只作为异步 listener 事后补救。Resource model 先保留同步 enforcement/audit boundary；具体哪些 runtime actions 落入该 boundary，由后续 auth/audit spec 定义。

### 7.2 Central service core controllers

| Controller | 读取 | 写入/输出 | Workflow 位置 | Invariant |
| --- | --- | --- | --- | --- |
| AgentSpec admission controller | AgentSpec request、class/profile registry、defaults、policy | resolved AgentSpec 或 validation error | 4.1、4.2 | resolved AgentSpec 必须能被 session、worker matching 和 recovery 理解。 |
| Session lifecycle controller | session record、events、worker state、policy/recovery result | session status、lifecycleReason、lifecycle event | 4.2、4.4、4.6、4.7、4.8 | session identity 和合法状态机不可替换；timeout/cancel/pause 策略可配置。 |
| Worker registry controller | sidecar registration、heartbeat、capacity/status report | Worker record、conditions、capacity state | 4.3、4.8 | Worker 最小注册字段和 condition 语义不可替换；credential backend 可替换。 |
| Worker selection controller | resolved AgentSpec、session state、Worker registry、policy、capacity | selected Worker 或 queued reason | 4.3、4.4、4.7、4.8 | 必须检查 policy/capacity/compatibility；placement policy 可替换。 |
| Session lease controller | session record、selected Worker、heartbeat/condition、lease TTL | currentWorkerId、sessionLeaseId、fencing decision | 4.4、4.6、4.7、4.8 | session lease 和 stale write rejection 不可替换。 |
| Event log controller | append/replay request、event store、idempotency key | event sequence/cursor、replay stream、append result | 4.2、4.5、4.6、4.7、4.8 | event envelope、ordering、cursor、idempotency 不可替换；storage backend 可替换。 |
| Event projection controller | event log、session metadata、snapshot markers | activity/status summary | 4.4、4.5 | projection 可以替换和重建，不能成为唯一 truth。 |
| Snapshot controller | session events、workspaceClass、checkpoint signal、storage result | snapshot metadata、latestSnapshotRef、snapshot marker event | 4.5、4.6、4.7、4.8 | snapshot 必须绑定 event boundary；scheduling policy 可替换。 |
| Recovery controller | session record、resolved AgentSpec、snapshot metadata、event log、Worker registry、recoveryPolicy | recovery mode、selected target Worker、recovery event、failure reason | 4.7、4.8 | 必须输出 true continuation/restart with context/non-recoverable failure；strategy 可替换。 |
| Worker capacity scaler | queued sessions、Worker capacity、AgentSpec/class constraints、hosting config | desired compute capacity | 4.3、4.7、4.8 | scaler 只输出 capacity intent，不拥有 session identity。 |

### 7.3 Adapters and process-local controllers

| Adapter / local controller | 读取 | 写入/输出 | Workflow 位置 | Replaceability |
| --- | --- | --- | --- | --- |
| Hosting adapter | desired capacity、hosting backend config | Kubernetes/container/VM/local process desired state | 4.3、4.7、4.8 | 可替换；不能让 hosting object 成为 session truth。 |
| Event transport adapter | event log cursor、client/backend subscription | SSE/WebSocket/broker/polling 增量 | 4.5 | 可替换；不能改变 event ordering/cursor truth。 |
| Sidecar connection adapter | runtime/deployment connection config、Worker registration、worker lease、event append stream、heartbeat/status | central-sidecar control/event channel | 4.3、4.4、4.5、4.7、4.8 | 可替换；不能进入 AgentSpec，不能改变 Worker identity、lease delivery、event append、fencing 和 replay 语义。 |
| Sidecar agent adapter | resolved AgentSpec、routed event、agent process state | agent input/output/status/tool event | 4.4、4.5、4.6、4.7、4.8 | 可替换；必须遵守 sidecar-facing API 和 event translation contract。 |
| Sidecar workspace adapter | workspaceRef、workspaceClass、snapshot metadata | prepared workspace、restore result、snapshot input | 4.4、4.5、4.6、4.7、4.8 | 可替换；不能改变 snapshot metadata 和 restore boundary。 |
| Tool/MCP adapter | toolProfile、tenant config、optional authorization result | tool call/result、permission request、audit input | 4.5 | 可替换；若 tool action 被纳入 auth/audit spec，则不能绕过 central enforcement。 |
| Workspace storage adapter | snapshot payload、storage config | storageLocation、checksum、size、restore stream | 4.5、4.6、4.7、4.8 | 可替换；必须返回稳定 snapshot metadata。 |
| Policy hook | principal、resource/action、customer context | allow/deny/reason | 被 auth spec 标记为受控的 action | 可替换；central service enforcement hook 不可替换。 |
| Audit sink | audit record | durable audit storage 或 SIEM export | 被 audit spec 标记为需要审计的 action | 可替换；最小 audit record 后续定义。 |

Process 边界在 hierarchy 的最后一层：

| Process | 可以包含什么 | 不应该拥有什么 |
| --- | --- | --- |
| Central session service | Session lifecycle、Worker registry、Worker selection、Worker lease、Event log、Event projection、Snapshot、Recovery、Authorization、Audit、Worker capacity scaler | agent process 内部状态、hosting platform 语义。 |
| Sidecar daemon | Worker registration、heartbeat、workspace prepare/restore、agent process supervision、event translation、snapshot submission | session durable identity、authorization enforcement 的最终决定、central-sidecar transport 语义。 |
| Agent process | 现有 CLI/framework/custom agent loop | runtime resource truth、worker registration。 |
| Hosting platform | pod/container/VM/local process lifecycle、resource limits、network/volume | session lifecycle、event log、recovery semantics。 |
| Persistent storage | session catalog、worker registry state、event log、workspace snapshot、agent session state bytes/metadata、audit record | controller policy 本身，也不解释 agent 私有 session 文件格式。 |

## 8. 信息传递和 Source of Truth

V1 可以使用 list/watch/subscribe/poll 来驱动 controller，但通知系统本身不是 truth。每个 controller 必须能从 persistent state 重建自己的视图。

```text
Persistent resource state + event log + audit log
        |
        | list/watch/subscribe/poll
        v
Controller or adapter
        |
        | writes state, event, audit, snapshot metadata, or desired capacity
        v
Persistent resource state + event log + audit log
```

信息传递规则：

1. Session record、event log、workspace snapshot metadata、Worker registry state 和 audit record 是 durable truth。
2. Event stream 用于实时通知和 replay transport，event log 才是 ordering/cursor truth。
3. Worker heartbeat/status 是 liveness 输入；Worker resource truth 在 central registry。
4. Session status/activity 可以由 event projection 得到，但 projection 可以重建，不能替代 event log。
5. Snapshot marker event 必须把 workspace snapshot 和 event cursor 对齐。
6. Session lease id 是 sidecar 写入 session event/status/snapshot 的 fencing token。
7. Authorization 和 audit 模块必须作为同步治理边界保留；具体 enforcement/action matrix 由后续 auth/audit spec 定义。
8. Hosting platform 可以报告 compute 状态，但不能成为 client routing、session identity 或 recovery truth。

## 9. 漏项和冗余校验

这条 workflow 可以作为资源模型的校验矩阵。

| Scenario 需求 | 必需 resource/controller | 如果没有会发生什么 |
| --- | --- | --- |
| Agent 定义必须在未来 resume/restore 时保持同一含义 | AgentSpec、AgentSpec admission、resolved copy/version/digest | 恢复会依赖当前名字解释，AgentSpec 漂移会破坏 session。 |
| Session 要先于 Worker 存在 | Session lifecycle、session catalog、event log | 没有 capacity 时 create session 会失败或丢失用户初始输入。 |
| 没有 Worker 时仍能排队并扩容 | Worker capacity scaler、hosting adapter、Worker registry | runtime 会把 capacity 问题暴露给 client，或让 app 自己调度 hosting。 |
| Compute 必须先注册才能服务 session | Worker resource、Worker registry、Authorization/Audit boundary | 未认证 sidecar 或错误 tenant capacity 可能承接 session。 |
| 消息不能写到旧 Worker | Session lease controller、sessionLeaseId | crash 或网络分区后可能出现两个 sidecar 同时写 session。 |
| Client 断线后能追上历史 | Event log controller、replay path、cursor | reconnect 只能依赖 transient stream，历史不可恢复。 |
| Approval 必须可追溯 | Event log、optional Authorization/Audit hook、Event transport | approval 会变成 worker-local promise，断线或 crash 后无法解释。 |
| Workspace 能 pause/resume/restore | WorkspaceSnapshot、Snapshot controller、workspace adapter、snapshot marker | event history 存在但工作现场丢失，coding/data agent 无法继续。 |
| Pause 后释放 capacity | Session lifecycle、Snapshot controller、Worker lease controller | pause 只是 UI 状态，旧 worker 仍占用或继续写。 |
| Resume 是同一个 session | Recovery controller、Worker selection、session lease、resolved AgentSpec | resume 会退化成新建 session，历史、权限和 audit 断裂。 |
| Worker crash 后恢复语义可解释 | Worker registry、Worker lease、Recovery controller、recovery event | worker failure 只是一条 error log，用户不知道任务能否继续。 |
| 治理边界进入 runtime path | Authorization controller、Audit controller、Policy/Audit resource | central service 会变成无权限感知的 WebSocket gateway，后续很难补 action matrix。 |

相反，下面这些候选对象在 V1 workflow 中没有成为独立 resource 的必要性：

| 候选对象 | V1 不建模为独立 resource 的原因 |
| --- | --- |
| WorkerPool resource | V1 可以先用 capacityScope、capacity profile、Worker registry 和 scaler output 表达；当多 pool quota、rollout、reservation 成为核心能力时再提升。 |
| DesiredCapacity resource | 需要作为 scaler 输出或 hosting adapter input，但不是 client-facing session resource；实现形态可以是 metric、queue depth 或 desired state record。 |
| Output resource | 输出先作为 workspace file、event output 或 tool result；只有出现独立分享、retention、lineage、跨 session 引用时再提升。 |
| Unified semantic context | V1 恢复基于 event log 和 workspace snapshot；统一 agent memory/context 会过早进入 agent framework 内部。 |
| Model provider gateway | AgentSpec 可以引用配置或 secret，但 runtime 不负责模型托管、路由或定价。 |
| Full agent framework | Sidecar 先适配已有 agent process，不要求客户重写 agent loop。 |
| Hosting platform resource model | Hosting adapter 输出 desired capacity；Kubernetes/container/VM 语义留给 hosting platform。 |
| Marketplace / full management UI | 不参与 session identity、routing、pause/resume 或 crash recovery 的最小闭环。 |
| Heterogeneous edge/personal-device routing | V1 先验证同质化 worker pool；异构 routing 需要更强的能力描述和信任模型。 |

## 10. V1 Non-goals

V1 resource model 不包含：

- 独立 output resource。
- model provider gateway。
- full agent framework 或 agent builder。
- marketplace。
- full management UI。
- 通用 hosting platform。
- heterogeneous personal-device/edge routing。
- unified semantic context schema。

这些能力以后可以增加，但必须作为 adapter、扩展 resource 或后续 product layer 加入，不能改变 V1 的核心 truth：Session 是 durable identity，Worker 是 replaceable compute，恢复从 event log、workspace snapshot 和 agentStatePolicy 声明的 session state 开始，authorization/audit 模块作为治理边界保留。

## 11. 架构评审问题

1. 这条 scenario 是否足够覆盖 V1 的核心事实：AgentSpec 定义、session creation、capacity scale-out、Worker 注册、run、pause、resume、crash restore？
2. Pause 的 V1 默认语义是否应该是 durable pause，即 snapshot 后释放 Worker lease，再通过 resume restore？还是必须支持 parked continuation？
3. Session lifecycle 是否需要显式包含 `pausing`、`paused`、`resuming`，还是把 pause/resume 都归入 recovery 状态机会更清楚？
4. AgentSpec resolved copy 需要冻结到什么粒度：labels、class/profile 名字、registry digest、tool profile、workspace contract、sidecar protocol version、pausePolicy、agentStatePolicy 是否都要记录？
5. Worker compatibility 是否只看 sidecarClass 和 workerSelector，还是必须把 workspaceClass、toolProfile、agentStatePolicy、recoveryPolicy 也纳入 matching？
6. Worker capacity scaler 应输出 declarative desired capacity，还是允许 imperative provisioning call？哪些 hosting-specific 状态不应进入 Session resource？
7. Event append 与 routed delivery 的语义是 at-least-once 加 idempotency，还是需要更强 per-session ordering guarantee？
8. Snapshot marker event、workspace snapshot metadata 和 agentStateRefs 的一致性失败时，session 应进入 `running`、`pausing`、`recovering` 还是 `failed`？
9. Approval、tool call 和 external side effect 在 crash recovery 时如何暴露未完成状态，而不是假装已经恢复？
10. Auth/audit spec 应如何定义 action matrix？本 resource model 只保留 Authorization/Audit 模块和同步治理边界。
11. 哪些 class/profile 需要 V1 就有 registry，哪些只需要配置文件或 static defaults？
12. Central-sidecar connection adapter 作为 runtime/deployment 级统一配置时，最小公共语义是什么，哪些 transport 差异不能泄漏进 AgentSpec 或 Session resource？
13. 如果某个 proposed controller 无法映射到这条 workflow 的读写事实，它是不是应该降级为内部模块、adapter 或后续阶段能力？