# Agent Runtime Sidecar POC Implementation Plan

状态：实现计划  
读者：POC implementer、runtime owner、sidecar owner、reviewer

## 1. 目的

这份文档把 [poc-runtime-workflow-spec-ch.md](poc-runtime-workflow-spec-ch.md) 拆成可实现、可测试、可 review 的 coding slices。它不按源码目录排序，而按 POC workflow 的业务可观察结果排序。

每个 slice 都必须有 scenario-based test。测试要证明 runtime 行为，而不是证明某个 private helper 被调用。

## 2. 实现原则

1. 先做 public contract，再做默认实现。
2. 先写 central-owned truth，再做 fan-out 或 sidecar command。
3. Web PubSub 只作为长连接 transport；session truth 不在 Web PubSub。
4. Tenant 是 high-level runtime boundary。POC 只有一个 `poc` tenant runtime，但 `tenantId` 不由 create session payload 自报。
5. Principal 来自 negotiate/connection 或 runtime message ingress context。Create session payload 不自报 `principal` 或 `owner`。
6. Docker container 启动只是 hosting 行为；sidecar registration 成功后，central 才能看到 ready Worker。
7. Copilot session history 由 Copilot 自己的 session files 承载；POC 通过 Docker volume snapshot/restore 保留这些文件。
8. 每个 slice 的测试都用 scenario 名字描述系统结果。
9. 不为 POC 添加 crash recovery、Kubernetes、完整 auth matrix、非 Web PubSub transport。

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
- Session status 是 `created` 或 `queued`，由是否已有 ready Worker 决定。
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

## 5. Slice 3：Docker Worker Registration

目标：Sidecar container 启动后能向 central 注册可用 worker capacity，central 能在 worker registry 里看到一个 ready Worker。

实现范围：

- Docker hosting adapter 启动 sidecar container。
- Sidecar 使用 `/sidecar/negotiate` 连接 Web PubSub。
- Sidecar publish `worker.register` 到 tenant inbox runtime channel。
- Worker registry controller 写 `workers/<workerId>.json`。

Scenario-based test：`scenario: sidecar container registers ready worker capacity`

Given：

- Docker adapter 启动 sidecar container，并返回 container id。
- Sidecar publish `worker.register`。

Expect：

- Central 分配 `workerId`。
- Worker record 包含 `sidecarId`。
- Worker record 的 `sidecarClass` 是 `copilot-process-wrapper`。
- Worker labels 包含 `agent=copilot`。
- Worker condition 是 `ready`。
- `hostingRef` 记录 Docker container id。

## 6. Slice 4：Queued Session Assignment

目标：Central 能把 queued session 分配给 matching ready Worker，并写入当前 worker lease。

实现范围：

- Worker selection controller。
- Worker lease controller。
- `currentWorkerId`。
- `workerLeaseGeneration`。
- `session.assign` command publish 到 worker commands runtime channel。

Scenario-based test：`scenario: queued session is assigned to matching ready worker`

Given：

- Session status 是 `queued`。
- Worker status 是 `ready`。
- Worker labels match AgentSpec `workerSelector`。

Expect：

- Central 选择该 Worker。
- Session status 变为 `starting`。
- Session record 写入 `currentWorkerId`。
- `workerLeaseGeneration` 增加。
- Central publish `session.assign` 到 worker commands runtime channel。
- 不匹配 labels 的 Worker 不会被选择。

## 7. Slice 5：Start Copilot On Sidecar

目标：Sidecar 收到 session assignment 后能挂载 workspace volume 和 Copilot session volume，并启动 Copilot process。

实现范围：

- Sidecar lease command controller。
- Sidecar workspace adapter。
- Copilot process adapter。
- Workspace Docker volume。
- Copilot session Docker volume。

Scenario-based test：`scenario: sidecar starts Copilot with assigned volumes`

Given：

- Sidecar 收到 `session.assign`。
- Assignment 包含 session id、lease generation、workspace volume、Copilot session volume。

Expect：

- Sidecar 记录 current lease generation。
- Sidecar 挂载 workspace volume。
- Sidecar 挂载 Copilot session volume。
- Copilot process adapter 收到两个 volume paths。
- Sidecar publish `status.changed` 到 tenant inbox runtime channel。

## 8. Slice 6：Run Session Event Loop

目标：Client input 经 central 持久化后到达 Copilot；Copilot output 经 central 持久化后到达 client。

实现范围：

- Client input event handling。
- Central append input event before routing。
- Worker commands runtime channel publish。
- Sidecar forwards input to Copilot process adapter。
- Sidecar output event publish。
- Central append output event and fan-out to session events runtime channel。

Scenario-based test：`scenario: input is persisted before routing to sidecar`

Given：

- Session 已 assigned 给 ready Worker。
- Client publish input event 到 tenant inbox runtime channel。

Expect：

- Central 先 append input event 到 `events.jsonl`。
- Central publish input command 到 worker commands runtime channel。
- Sidecar forwards input to Copilot adapter。
- Sidecar publish output to tenant inbox runtime channel。
- Central append output event。
- Central publish output to session events runtime channel。
- Client 不知道 Worker endpoint。

## 9. Slice 7：Pause Session With Volume Snapshot

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

## 10. Slice 8：Resume Session From Volume Snapshot

目标：Paused session 能恢复 workspace volume 和 Copilot session volume，重启 Copilot，并回到 running。

实现范围：

- `session.resume.requested` handling。
- Recovery controller planned resume path。
- Docker worker capacity ensure。
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

## 11. Slice 9：Reconnect And Replay

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

## 12. Slice 10：Thin Auth And Audit Boundary

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

## 13. Recommended Order

按下面顺序实现和 review：

1. Durable session truth。
2. Web PubSub client-connection transport。
3. Docker worker registration。
4. Queued session assignment。
5. Start Copilot on sidecar。
6. Run session event loop。
7. Pause with volume snapshot。
8. Resume from volume snapshot。
9. Reconnect and replay。
10. Thin auth and audit boundary。

前六个 slices 跑通后，POC 已经形成可交互主线；pause/resume 再验证 Copilot session volume 和 workspace volume 的 durable boundary。

## 14. Validation Commands

每个 slice 完成后都运行：

```powershell
pnpm build
pnpm typecheck
pnpm test
```

新增测试要放在对应 runtime 行为附近，命名以 `scenario:` 开头。测试断言 public outcome：session file、event log、worker record、published group event、snapshot directory、restored volume content。不要测试私有 helper 形状。