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
6. Worker 是注册进 tenant runtime 的可用 capacity。POC 支持两类 capacity source：standalone sidecar direct registration、WorkerPool controller/adaptor provisioned registration；注册成功后都进入同一套 Worker registry contract。
7. Worker selection 只使用 AgentSpec selector 与 Worker record 上的 `sidecarClass`、labels、capacity、conditions；不按 standalone、Docker、WorkerPool source 分叉。
8. Worker registry 必须区分 active Worker 和历史/tombstone record。只有 active、ready、allocatable 的 Worker 能被 selection；closed、expired、disconnected、draining 且无可分配容量的 Worker 都不能被分配新 session。
9. 先跑通 standalone sidecar worker、Copilot process-wrapper 和多轮 session event loop，再接入 WorkerPool provisioning 和 WorkerCapacityScaler。
10. Copilot session history 由 Copilot 自己的 session files 承载；POC 通过本地 session 目录验证 process-wrapper 行为，通过 Docker volume snapshot/restore 保留这些文件。
11. 每个 slice 的测试都用 scenario 名字描述系统结果。
12. 不为 POC 添加 crash recovery、Kubernetes、完整 auth matrix、非 Web PubSub transport。

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
- Client publish `session.create.requested` 到 tenant inbox runtime channel。
- Payload 包含 `agent.agentSpecId`、`input.initialMessage`、`input.clientRequestId`、`workspace.source`。
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

- Client 持有 central negotiate 返回的 token。
- Web PubSub adapter 使用 tenant-prefixed group 映射。
- 本 slice 不展开 token 最小权限矩阵。

Expect：

- Client publish `session.create.requested` 到 tenant inbox runtime channel 对应的 Web PubSub group。
- Central runtime connection 收到该 event，并把 `fromUserId` 还原为 transport envelope 中的 principal context。
- Tenant runtime 能从 tenant inbox 处理该 event；local truth 写入由 Slice 1 的 durable session scenario 覆盖。
- Test 不使用 Web PubSub upstream，不暴露 central callback endpoint。

## 5. Slice 3：Standalone Sidecar Worker Lifecycle

目标：先不依赖 WorkerPool provisioning 和 WorkerCapacityScaler，手动启动一个 standalone sidecar，让它通过同一个 Worker lifecycle contract 注册、保活、更新容量、退出和过期摘除。这个 slice 要把 Worker 作为可用 capacity 的完整生命周期做好，而不是只证明一次 register 成功。

实现范围：

- Sidecar daemon 的 standalone worker mode，启动参数包含 central URL、tenant id、sidecar identity、labels、capacity。
- Sidecar 使用 central URL 和 tenant id 调用 `/sidecar/negotiate?tenantId=<tenantId>`，拿到 Web PubSub client access URL。
- Sidecar 使用 `/sidecar/negotiate` 连接 runtime transport；scenario test 可使用 in-memory runtime transport。
- Sidecar publish `worker.register` 到 tenant inbox runtime channel。
- Sidecar 定期 publish `worker.heartbeat`，刷新 `heartbeatAt`、`expiresAt`、capacity、allocatable、conditions。
- Sidecar graceful shutdown 时先 publish `worker.drain.requested`；没有 active lease 后再 publish `worker.close.requested`。
- Worker registry controller 写 `workers/<workerId>.json`，并维护 active worker index。
- Worker record 包含 `workerId`、`sidecarId`、`sidecarClass`、labels、capacity、allocatable、conditions、`heartbeatAt`、`expiresAt`、`generation`、terminal reason。
- Worker lifecycle controller 处理 register、heartbeat、condition/capacity update、draining、close、disconnect/TTL expiry、active index removal。
- Keepalive expiry scan 使用 central time 判断过期 Worker，并把它从 active worker index 摘掉。
- Worker close 发生在 active lease 上时，central append lease lost event；keepalive expiry 发生在 active lease 上时，central append lease lost event。POC 不自动 crash recovery，session 进入 `failed`，并记录 `worker_lost` reason。
- Terminal Worker 不会被旧 heartbeat 复活；sidecar restart 与 WorkerPool reprovision 必须重新走 `worker.register` 并获得新的 active Worker generation。
- Worker selection controller 只读取 active worker index 中 ready 且 allocatable 的 Worker。

Scenario-based test：`scenario: standalone sidecar registers ready worker capacity`

Given：

- Central tenant runtime 已启动。
- Standalone sidecar 带着 `sidecarClass=copilot-process-wrapper`、`labels.agent=copilot` 和 capacity 1 启动。
- WorkerCapacityScaler 未参与本 scenario。

Expect：

- Central 分配 `workerId`。
- Worker record 包含 `sidecarId`。
- Worker record 的 `sidecarClass` 是 `copilot-process-wrapper`。
- Worker labels 包含 `agent=copilot`。
- Worker capacity/allocatable 是 1。
- Worker condition 是 `ready`。
- Worker registry 让该 Worker 进入和后续 WorkerPool provisioned Worker 相同的 selection path。
- Central 不调用 WorkerPool controller/adaptor，也不调用 WorkerCapacityScaler。

Scenario-based test：`scenario: sidecar negotiates real Web PubSub connection and registers worker`

Given：

- `tests/.env` 提供 `WEBPUBSUB_ENDPOINT`。
- Central HTTP server 已启动，并暴露 `/sidecar/negotiate?tenantId=<tenantId>`。
- Central runtime 使用真实 Web PubSub client connection 订阅 tenant inbox runtime channel。
- Standalone sidecar 只拿到 central URL、tenant id、sidecar identity、labels、capacity。

Expect：

- Sidecar 调用 central `/sidecar/negotiate?tenantId=<tenantId>`。
- Central 为该 tenant 的 sidecar runtime channels 颁发 Web PubSub client access URL。
- Sidecar 使用 access URL 建立真实 Web PubSub client connection。
- Sidecar publish `worker.register` 到 tenant inbox runtime channel。
- Central runtime connection 从真实 Web PubSub 收到 `worker.register`。
- Central 写入 active Worker record。
- Worker record 的 tenant 来自 sidecar 启动时使用的 tenant id。
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

Scenario-based test：`scenario: graceful worker close removes worker from active selection`

Given：

- Worker 已注册且没有 active lease。
- Sidecar publish `worker.close.requested`。

Expect：

- Central append `worker.closed` event。
- Worker record 进入 terminal closed state，并记录 reason。
- Worker 从 active worker index 摘掉。
- Worker selection 不再返回该 Worker。
- Close 行为不读取 Worker source。

Scenario-based test：`scenario: draining worker stops new assignment while existing lease finishes`

Given：

- Worker 已注册且可能持有 active lease。
- Sidecar publish `worker.drain.requested`。

Expect：

- Central append `worker.draining` event。
- Worker condition 变为 `draining`。
- Worker 保留已有 lease，但 allocatable 对新 assignment 变为 0。
- Worker selection 不再为新 queued session 返回该 Worker。
- Existing lease 正常 release 后，sidecar 可以 close，central 再把 Worker 从 active worker index 摘掉。

Scenario-based test：`scenario: expired worker keepalive removes worker from active selection`

Given：

- Worker 已注册且在 active worker index 中。
- Central time 超过该 Worker 的 `expiresAt`。
- 没有收到新的 `worker.heartbeat`。

Expect：

- Keepalive expiry scan append `worker.expired` event。
- Worker record 进入 expired/disconnected terminal state，并记录 last heartbeat。
- Worker 从 active worker index 摘掉。
- Worker selection 不再返回该 Worker。
- 过期摘除不依赖 Worker source。

Scenario-based test：`scenario: leased worker close marks lease lost without crash recovery`

Given：

- Worker 已被某个 session lease 持有。
- Sidecar close 发生在 lease release 之前。

Expect：

- Central append `worker.closed` event。
- Central append session-scoped `worker.lease.lost` event。
- Worker 从 active worker index 摘掉。
- Session 不再向该 Worker route input。
- POC 不自动恢复该 session；session 进入 `failed`，并记录 `worker_lost` reason。

Scenario-based test：`scenario: leased worker expiry marks lease lost without crash recovery`

Given：

- Worker 已被某个 session lease 持有。
- Central time 超过该 Worker 的 `expiresAt`，并且 lease release 尚未发生。

Expect：

- Central append `worker.expired` event。
- Central append session-scoped `worker.lease.lost` event。
- Worker 从 active worker index 摘掉。
- Session 不再向该 Worker route input。
- POC 不自动恢复该 session；session 进入 `failed`，并记录 `worker_lost` reason。

Scenario-based test：`scenario: stale heartbeat cannot resurrect terminal worker`

Given：

- Worker 已经进入 terminal state，并已从 active worker index 摘掉。
- Central 随后收到旧 generation 的 `worker.heartbeat`。

Expect：

- Central 不把该 Worker 放回 active worker index。
- Central 不更新该 Worker 为 `ready`。
- Central append `worker.heartbeat.rejected` event。
- Sidecar restart 必须重新 publish `worker.register`，形成新的 active Worker generation。

## 6. Slice 4：Queued Session Assignment To Registered Worker

目标：Central 能把 queued session 分配给已经注册的 matching ready Worker，并写入当前 worker lease。

实现范围：

- Worker selection controller。
- Worker lease controller。
- `currentWorkerId`。
- `workerLeaseGeneration`。
- `session.assign` command publish 到 worker commands runtime channel。

Scenario-based test：`scenario: queued session is assigned to a registered ready worker`

Given：

- Session status 是 `queued`。
- Worker registry 中已有一个 `ready` Worker。
- Worker labels match AgentSpec `workerSelector`。
- WorkerCapacityScaler 未参与本 scenario。

Expect：

- Central 选择该 Worker。
- Session status 变为 `starting`。
- Session record 写入 `currentWorkerId`。
- `workerLeaseGeneration` 增加。
- Central publish `session.assign` 到 worker commands runtime channel。
- 不匹配 labels 的 Worker 不会被选择。
- Central 不尝试 scale 出新 Worker。

## 7. Slice 5：Start Copilot On Registered Sidecar

目标：已注册 Worker 的 sidecar 收到 session assignment 后，能在分配给该 session 的 workspace 和 Copilot session 目录上启动 Copilot process，使 Worker 上出现 running agent。

实现范围：

- Sidecar lease command controller。
- Sidecar workspace adapter。
- Copilot process adapter。
- 本地 workspace 目录。
- 本地 Copilot session 目录。
- Sidecar status reporting。

Scenario-based test：`scenario: registered sidecar starts Copilot for assigned session`

Given：

- Sidecar 收到 `session.assign`。
- Assignment 包含 session id、lease generation、workspace path、Copilot session path。

Expect：

- Sidecar 记录 current lease generation。
- Sidecar 准备本地 workspace 目录。
- Sidecar 准备本地 Copilot session 目录。
- Copilot process adapter 收到 workspace path 和 Copilot session path。
- Sidecar publish `status.changed` 到 tenant inbox runtime channel。
- Central append status event，并把 session status 推进到 `running`。

## 8. Slice 6：Multi-Turn Copilot Session Event Loop

目标：Central 可以令 Worker 上的 running agent 处理用户问题；client 能收到回复，并且同一个 session 支持多轮交流。这个 slice 同时建立 agent-generated runtime events 的主路径：agent output、tool event、status event、error event 都由 sidecar 先 publish 到 tenant inbox，再由 central append 到 session event log 后 fan-out。

实现范围：

- Client input event handling。
- Central append input event before routing。
- Worker commands runtime channel publish。
- Sidecar forwards input to Copilot process adapter。
- Sidecar 把 Copilot output、tool event、status event、error event 转成 runtime event publish 到 tenant inbox runtime channel。
- Central append agent-generated events and fan-out to session events runtime channel。
- 同一 session 的 turn correlation、event cursor 和 lease generation 校验。

Scenario-based test：`scenario: same session supports multi-turn Copilot exchange`

Given：

- Session 已 assigned 给 registered ready Worker，并且 Copilot process 已 running。
- Client publish 第一轮 input event 到 tenant inbox runtime channel。
- Client 随后对同一个 `sessionId` publish 第二轮 input event。

Expect：

- Central 在每一轮都先 append input event 到 `events.jsonl`，再 route 到 Worker。
- Sidecar forwards 两轮 input 到同一个 Copilot process/session context。
- Sidecar 对每一轮都 publish output event 到 tenant inbox runtime channel；如果 Copilot adapter 产生 tool/status/error event，也走同一入口。
- Central append 两轮 output event，并 append 同一 session 内的 tool/status/error event。
- Central publish 已持久化的 agent-generated events 到 session events runtime channel。
- Client 可以按 event cursor 看到同一个 session 的连续多轮回复。
- Client 不知道 Worker endpoint。

Automated scenario test 可以使用实现同一 process-wrapper contract 的 deterministic Copilot test harness；本地 smoke test 使用真实 Copilot CLI 验证同一路径能产生真实回复。

## 9. Slice 7：Docker WorkerPool Provisioning

目标：在 standalone sidecar worker 闭环已经跑通后，增加一个 POC Docker WorkerPool controller/adaptor。它负责 provision sidecar，但 provision 出来的 sidecar 仍然通过同一个 `worker.register` contract 成为普通 Worker。

实现范围：

- POC Docker WorkerPool record/config。
- Docker WorkerPool controller/adaptor 启动 sidecar container。
- Sidecar container 使用 `/sidecar/negotiate` 连接 Web PubSub。
- Sidecar container publish `worker.register`。
- Docker workspace volume。
- Docker Copilot session volume。
- WorkerPool source/provisioning metadata 不进入 Worker selection 条件。

Scenario-based test：`scenario: docker worker pool provisions a worker using the same registration contract`

Given：

- POC Docker WorkerPool controller/adaptor 启动 sidecar container。
- Container 内 sidecar 使用与 standalone sidecar 相同的 registration、assignment 和 Copilot process-wrapper contract。

Expect：

- Sidecar container publish `worker.register`。
- Central 分配 `workerId`。
- Worker record shape 与 standalone sidecar 注册出的 Worker 一致。
- Worker record 的 `sidecarClass` 是 `copilot-process-wrapper`。
- Worker labels 包含 `agent=copilot`。
- Worker capacity/allocatable 是 1。
- Worker condition 是 `ready`。
- Worker selection 不使用 Docker container id，也不使用 WorkerPool source。
- Session assignment 后，sidecar 使用 Docker workspace volume 和 Copilot session volume 启动 Copilot process。
- 该 Worker 能完成至少一轮 input/output event loop。

## 10. Slice 8：WorkerCapacityScaler Uses WorkerPool

目标：只有在 standalone sidecar worker 和 Docker WorkerPool provisioned Worker 都已验证后，WorkerCapacityScaler 才负责在没有 matching ready Worker 时调用 matching WorkerPool controller/adaptor provision 新 Worker。

实现范围：

- WorkerCapacityScaler。
- WorkerPool registry/controller selection。
- Docker WorkerPool controller/adaptor integration。
- create/queued 后的 capacity ensure path。
- 新 Worker registration 后触发 queued session assignment。

Scenario-based test：`scenario: queued session causes scaler to provision a worker from matching worker pool`

Given：

- Session status 是 `queued`。
- Worker registry 中没有 matching ready Worker。
- AgentSpec `workerSelector` 需要 `agent=copilot`。
- POC Docker WorkerPool 声明它能 provision `sidecarClass=copilot-process-wrapper`、`labels.agent=copilot` 的 Worker。

Expect：

- WorkerCapacityScaler 选择 matching WorkerPool 并调用其 controller/adaptor provision sidecar。
- Provisioned sidecar 注册 ready Worker。
- Central 把 queued session assignment 给新 Worker。
- Session status 变为 `starting`，随后在 sidecar 启动 Copilot 后变为 `running`。
- Worker selection 仍然只看注册后的 Worker record，不走 WorkerPool 旁路匹配路径。
- Client 仍然只面向 session 通信，不知道 WorkerPool、Docker container、Worker endpoint。

## 11. Slice 9：Pause Session With Volume Snapshot

目标：Running session 能进入 paused，并生成同一 event boundary 下的 workspace volume snapshot 和 Copilot session volume snapshot。

实现范围：

- `session.pause.requested` handling。
- Session status `running -> pausing -> paused`。
- Pause command to worker commands runtime channel。
- Sidecar reaches turn-boundary pause。
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
- Client publish `session.pause.requested` 到 tenant inbox runtime channel。

Expect：

- Central append `pause.requested`。
- Session status 变为 `pausing`。
- Sidecar receives pause command。
- Snapshot controller copies workspace volume to snapshot directory。
- Snapshot controller copies Copilot session volume to the same snapshot directory。
- Snapshot metadata `baseEventCursor` matches event boundary。
- Central append `snapshot.created` marker event。
- `latestSnapshotRef` is updated。
- Worker lease is released。
- Session status 变为 `paused`。

## 12. Slice 10：Resume Session From Volume Snapshot

目标：Paused session 能恢复 workspace volume 和 Copilot session volume，重启 Copilot，并回到 running。

实现范围：

- `session.resume.requested` handling。
- Recovery controller planned resume path。
- WorkerPool capacity ensure。
- Docker volume adapter restore。
- Worker lease assignment。
- Sidecar starts Copilot after restore。
- Session status `paused -> resuming -> running`。

Scenario-based test：`scenario: resume restores volumes before starting Copilot`

Given：

- Session status 是 `paused`。
- Latest snapshot contains workspace and Copilot session volume copies。
- Client publish `session.resume.requested` 到 tenant inbox runtime channel。

Expect：

- Central reads latest snapshot。
- Docker volume adapter restores workspace volume。
- Docker volume adapter restores Copilot session volume。
- Restored workspace volume contains expected file。
- Restored Copilot session volume contains expected session file。
- Central writes a new worker lease generation。
- Sidecar starts Copilot after restore completes。
- Central append `session.resumed`。
- Session status 变为 `running`。

## 13. Slice 11：Reconnect And Replay

目标：Client 断线后能用 event cursor 追上 session history。

实现范围：

- Event replay API/function。
- Client reconnect with cursor。
- Session events runtime channel resubscribe。

Scenario-based test：`scenario: reconnect replays events after client cursor`

Given：

- Session event log contains sequence 1 到 5。
- Client reconnects with cursor 2。

Expect：

- Central returns events with sequence 3 到 5。
- Replay comes from `events.jsonl`。
- Replay does not depend on Web PubSub message history。
- Client still does not know Worker endpoint。

## 14. Slice 12：Thin Auth And Audit Boundary

目标：POC 保留 central-owned negotiate 和 audit hook，但不展开完整 production auth matrix。

实现范围：

- `/client/negotiate`。
- `/sidecar/negotiate`。
- Demo principal from POC HTTP route request context。
- Audit append for create、register、pause、resume。

Scenario-based test：`scenario: negotiate is central-owned`

Given：

- Client requests token from central negotiate。
- Sidecar requests token from central negotiate。

Expect：

- Client token is issued by central for the runtime channels allowed in the POC path。
- Sidecar token is issued by central for the runtime channels allowed in the POC path。
- Browser and sidecar do not choose their own `userId`。
- Audit log records token issuance as record-only。

## 15. Recommended Order

按下面顺序实现和 review：

1. Durable session truth。
2. Web PubSub client-connection transport。
3. Standalone sidecar worker lifecycle。
4. Queued session assignment to registered worker。
5. Start Copilot on registered sidecar。
6. Multi-turn Copilot session event loop。
7. Docker WorkerPool provisioning。
8. WorkerCapacityScaler uses WorkerPool。
9. Pause with volume snapshot。
10. Resume from volume snapshot。
11. Reconnect and replay。
12. Thin auth and audit boundary。

前六个 slices 跑通后，POC 已经形成可交互主线：central 能把同一个 session 的多轮 input 路由到 registered Worker 上的 running Copilot agent，并把回复持久化后推回 client。WorkerPool provisioning 和 WorkerCapacityScaler 在这条主线之后接入，验证它们只是 capacity source，不改变 Worker registration、selection、assignment、event loop 的统一路径。

## 16. Validation Commands

每个 slice 完成后都运行：

```powershell
pnpm build
pnpm typecheck
pnpm test
```

新增测试要放在对应 runtime 行为附近，命名以 `scenario:` 开头。测试断言 public outcome：session file、event log、worker record、published group event、snapshot directory、restored volume content。不要测试私有 helper 形状。

Slice 3 必须包含真实 Web PubSub e2e integration test，覆盖 standalone sidecar 从 central URL 和 tenant id 启动、调用 central `/sidecar/negotiate`、连接 Web PubSub、publish `worker.register`、central 写入 active Worker record。缺少 `WEBPUBSUB_ENDPOINT` 时测试 skip；环境可用时该 e2e 是必跑验证项。