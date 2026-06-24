# Agent Runtime Sidecar POC Spec

状态：POC 目标态  
读者：runtime owner、sidecar owner、SDK/API owner、POC implementer

## 1. 目的

这份 spec 定义第一个 POC 的最小实现边界。POC 要跑通从 AgentSpec 定义、session 创建、Docker worker 启动、Worker 注册、session 运行，到 pause/resume 的完整 workflow；暂不处理 Worker crash 后的自动 restore。

POC 的原则是：默认实现简单，但架构层次必须正确。也就是说，POC 固定使用 Copilot agent、本地 file storage、Web PubSub transport、Docker worker、单 central instance；但 AgentSpec、Session、Worker、Event、WorkspaceSnapshot、controller、adapter 的边界不能写错，也不能把 POC 的默认实现硬编码成未来资源模型。

## 2. POC 范围

POC 支持：

- 单 central service instance。
- Central 启动时按 multi-tenant 结构组织；POC 只创建一个预定义 tenant runtime：`poc`。
- Agent 本体固定为 Copilot。
- Central 本地 file storage。
- Central 与 client 之间通过 Web PubSub 通信。
- Central 与 sidecar 之间通过 Web PubSub 通信。
- Worker 只考虑 Docker container。
- 一组预定义 `sidecarClass`、`workspaceClass`、`toolProfile`、`pausePolicy`、`recoveryPolicy`、`agentStatePolicy`，参数只保留 POC 运行必需项。
- 基于 Worker labels 的 `workerSelector`。
- Session create、run、pause、resume。
- Docker workspace volume 和 Copilot session volume 的 snapshot/restore。

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
| Docker volume snapshot storage | Central 本地 snapshot 目录 | Worker 上的 workspace 和 Copilot session history 分别在 Docker volumes 中；pause/resume 时由 Docker volume adapter 复制，central 不解释 Copilot session 文件格式。 |

Web PubSub 的 POC 形态是：central、client、sidecar 都作为 Web PubSub clients 连接。Web PubSub 不启用 upstream，不要求 central 暴露公网 callback endpoint，也不把 Web PubSub 当作业务处理方。它只提供一条能跨网络保持的长连接；central 收到事件后写本地 storage，再通过自己的 Web PubSub client connection 把结果发到 session events 和 worker commands runtime channels。

## 4. Web PubSub 映射

POC 使用 hub `agentruntimepoc`。

| Runtime 概念 | Web PubSub 映射 |
| --- | --- |
| Central runtime connection | Web PubSub client connection，由 central 自己通过服务端配置获取 token。 |
| Client connection | Web PubSub client connection，由 central `/client/negotiate` 颁发 token。 |
| Sidecar connection | Web PubSub client connection，由 central `/sidecar/negotiate` 颁发 token。 |
| Tenant inbox runtime channel | Web PubSub group `tenant:{tenantId}:central:events`，client/sidecar 的 runtime events 先发到这里。 |
| Session events runtime channel | Web PubSub group `tenant:{tenantId}:session:{sessionId}`。 |
| Worker commands runtime channel | Web PubSub group `tenant:{tenantId}:worker:{workerId}`。 |
| Client writes | client publish 到 tenant inbox runtime channel，payload 中包含 session/action/correlation 信息。 |
| Sidecar writes | sidecar publish 到 tenant inbox runtime channel，payload 中包含 worker/session/lease generation 信息。 |
| Central fan-out | central 作为 Web PubSub client publish 到 session events 和 worker commands runtime channels。 |

Web PubSub group name 是 adapter-internal 映射，不进入 shared runtime contract。Shared contract 只暴露 `tenant-inbox`、`session-events`、`worker-commands` 这类 runtime channels。Group membership 和 roles 由 central 在 negotiate 时基于 runtime channels 生成；POC 当前不展开最小权限矩阵。

POC 的 `/negotiate` 仍然是 central-owned boundary。当前 demo route 在 HTTP 入口层构造 demo `RequestContext`，Web PubSub adapter 把 principal 编入 token `userId`，tenant runtime 收到消息时从 transport envelope 取得 per-message context。Create session payload 不携带 `tenantId`、`principal`、`owner`。

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
- Snapshot controller 写 `snapshot.json`，并通过 Docker volume adapter 把 workspace volume 和 Copilot session volume 保存到同一个 snapshot boundary 下。
- Audit controller append `audit.jsonl`，具体 action matrix 后续定义。

POC 使用单 central 进程串行写，暂不处理多 central 并发。

## 6. Docker Worker 和 Sidecar

POC 的 Worker 来自 Docker container，但 Docker container 本身不是 Worker resource。Docker adapter 负责启动/停止 container，并为每个 session 准备两个 Docker volumes：workspace volume 和 Copilot session volume。Container 内的 sidecar 启动后，通过 Web PubSub 连接 central，并发送 `worker.register` custom event。

Worker 最小 registration payload：

| 字段 | POC 含义 |
| --- | --- |
| `workerId` | central 在处理 `worker.register` 时分配。 |
| `sidecarId` | sidecar process identity。 |
| `sidecarClass` | POC 预定义 `process-wrapper`。 |
| `labels` | 任意 key/value，用于 `workerSelector`。 |
| `capacity` / `allocatable` | 固定为 1。 |
| `conditions` | ready、busy、draining、disconnected。 |
| `heartbeatAt` | sidecar 定期上报。 |
| `hostingRef` | Docker container id/name，仅用于诊断。 |

Worker selection 只使用 `sidecarClass`、`workerSelector` 对 Worker labels 的匹配结果、capacity、conditions。不要在 POC 里增加新的 selector 字段或复杂匹配模型。

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

POC 使用预定义 class/profile，而不是把所有值都叫 `default`。这些值应该表达 POC 的真实实现选择，参数保持最小：

| 字段 | POC 预定义值 | 含义 |
| --- | --- | --- |
| `sidecarClass` | `copilot-process-wrapper` | sidecar 以 process wrapper 方式启动 Copilot agent。 |
| `workspaceClass` | `docker-workspace-volume-snapshot` | workspace 是 Docker volume，snapshot 由 Docker volume adapter 复制到 central 本地 file storage。 |
| `toolProfile` | `copilot-poc-tools` | 只装配 Copilot POC 需要的最小工具集合。 |
| `pausePolicy` | `turn-boundary-durable-pause` | pause 在 turn/checkpoint 边界完成，snapshot 后释放 worker lease。 |
| `recoveryPolicy` | `restart-with-context` | POC 默认 resume 模式是恢复 workspace/event context 后重启 agent。 |
| `agentStatePolicy` | `copilot-session-volume-snapshot` | capture/restore Copilot session volume；Copilot session history 保留在 Copilot 自己的 session 文件里。 |

这些 class/profile 在 POC 中由静态 registry 文件定义；它们仍然作为 AgentSpec 字段出现，避免 controller 直接硬编码实现细节。

### 7.2 Create Session

Create session 的语义是 client 请求当前 tenant runtime 创建 durable session。POC 的传输实现固定为：client publish `session.create.requested` 到 tenant inbox runtime channel；Web PubSub adapter 把该 channel 映射为 `tenant:poc:central:events` group。Payload 只描述要创建什么 session，不自报 tenant 或 principal：`agent.agentSpecId`、`input.initialMessage`、`input.clientRequestId`、`workspace.source`。Tenant runtime 从 transport envelope 得到 principal context，从 tenant runtime 配置得到 tenant `poc`，然后创建 `session.json`，再 append `session.created` 和 initial input event。

如果没有 ready Worker，session 进入 `queued`。Worker capacity scaler 调用 Docker adapter 启动一个 sidecar container。

### 7.3 Register Worker

Sidecar container 连接 Web PubSub 后发送 `worker.register`。Central 写 Worker record。Worker ready 后，Worker selection controller 找到 queued session，Worker lease controller 写入 `currentWorkerId` 和 `workerLeaseGeneration`。

Central publish `session.assign` 到 worker commands runtime channel；Web PubSub adapter 映射为 `tenant:poc:worker:{workerId}` group。Sidecar 收到后挂载 workspace volume 和 Copilot session volume，并按 AgentSpec launch 启动 Copilot process。

### 7.4 Run Session

Client input 通过 Web PubSub publish 到 tenant inbox runtime channel。Central 的 Web PubSub client connection 收到后 append input event，再 publish 到 worker commands runtime channel。Sidecar 转给 Copilot process。

Agent output、tool event、status event 由 sidecar publish 到 tenant inbox runtime channel。Central append event 后，publish 到 session events runtime channel。Client 从 session events channel 接收 stream。

### 7.5 Pause Session

Pause session 的语义是 client 请求 central 把 running session 带到 durable pause boundary。POC 的传输实现固定为：client publish `session.pause.requested` 到 tenant inbox runtime channel。Central append `pause.requested`，把 session 状态改为 `pausing`，并 publish pause command 到 worker commands runtime channel。

Sidecar 根据 `pausePolicy` 到达 safe boundary：停止接收新 input，flush output，确保 Copilot session 文件落盘，再通知 Snapshot controller 保存 Docker volumes。

Snapshot controller 在同一个 event boundary 上调用 Docker volume adapter：先复制 workspace volume，再复制 Copilot session volume，最后写 `snapshot.json` 和 snapshot marker event。Snapshot 完成后，central 更新 `latestSnapshotRef`，释放当前 worker lease，把 session 状态改为 `paused`。POC 默认 durable pause，不保留 parked continuation。

### 7.6 Resume Session

Resume session 的语义是 client 请求 central 从 paused session 恢复执行投影。POC 的传输实现固定为：client publish `session.resume.requested` 到 tenant inbox runtime channel。Central 读取 session、latest snapshot、resolved AgentSpec、pausePolicy、agentStatePolicy 和 recoveryPolicy。POC 不处理 crash recovery，但 resume 仍然走 Recovery controller 的 planned path。

Central 选择 ready Worker；没有 ready Worker 时，Worker capacity scaler 调用 Docker adapter 启动一个 sidecar container。新 Worker 获得 lease 前，Snapshot controller 调用 Docker volume adapter 从 latest snapshot 恢复 workspace volume 和 Copilot session volume。Sidecar 挂载恢复后的 volumes，然后启动 Copilot process。

恢复模式：

| 模式 | POC 行为 |
| --- | --- |
| True continuation | POC 不使用。 |
| Restart with context | POC 固定模式：恢复 workspace volume、event history 和 Copilot session volume 后重启 Copilot。 |
| Non-recoverable failure | snapshot 缺失、Copilot session volume snapshot 缺失时进入 failed。 |

Resume 成功后，central append `session.resumed`，并把 session 改回 `running`。

## 8. Controllers 和 Adapters

| Controller / adapter | POC 默认职责 |
| --- | --- |
| AgentSpec admission controller | 读取静态 AgentSpec，解析 POC 预定义 class/profile。 |
| Session lifecycle controller | create、queued、starting、running、pausing、paused、resuming、failed。 |
| Worker registry controller | 接收 sidecar registration 和 heartbeat，写本地 Worker file。 |
| Worker selection controller | 用 `sidecarClass`、Worker labels、capacity、conditions 选择 Worker。 |
| Worker lease controller | 写 `currentWorkerId`、`workerLeaseGeneration`，拒绝旧 generation 写入。 |
| Event log controller | append/replay 本地 `events.jsonl`。 |
| Snapshot controller | 编排 workspace volume 和 Copilot session volume 的 snapshot/restore，并写 marker event。 |
| Recovery controller | 只处理 planned resume，不处理 crash restore。 |
| Worker capacity scaler | POC 中直接调用 Docker adapter 启动一个 container。 |
| Web PubSub transport adapter | 统一处理 central/client/sidecar client connection、negotiate、runtime channel 到 tenant-prefixed Web PubSub group 的映射，以及 group publish。 |
| Docker hosting adapter | 启动/停止 sidecar container，记录 Docker hostingRef。 |
| Docker volume adapter | 在 Snapshot controller 调用下复制和恢复 workspace volume、Copilot session volume。 |
| Sidecar agent adapter | Copilot process-wrapper 实现。 |
| Sidecar workspace adapter | 挂载 Docker workspace volume 和 Copilot session volume。 |
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
8. Pause 后生成 workspace volume snapshot 和 Copilot session volume snapshot，session 进入 `paused`。
9. Resume 后恢复 workspace volume 和 Copilot session volume，Copilot process 启动，session 回到 `running`。
10. Client 断线重连后通过 event cursor replay 已有 events。

## 10. 后续不在 POC 内

- Worker crash detection 和自动 restore。
- 多 central instance 和 shared database。
- Kubernetes/VM hosting adapter。
- 生产级 auth/action matrix。
- Web PubSub 以外的 transport 实现。
- 独立 output resource。
- 复杂 WorkerPool、quota、reservation、rollout。