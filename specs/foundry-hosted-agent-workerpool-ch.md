# Foundry Hosted Agent WorkerPool Spec：把 Foundry 作为又一类 host-pool adapter（worker pool 后端）

状态：目标态设计（design；实现按 §11 切片推进）
读者：架构师、runtime owner、worker/hosting owner、sidecar owner

## 1. 范围与边界

把 **Foundry Hosted Agent** 当作**又一个 hosting 后端**：它托管的 per-session 容器里跑的就是**我们的 sidecar 镜像**，和 Docker host pool 平级。

分工固定为：

- **Foundry 拥有**：per-session 托管 compute、idle scale-to-zero、镜像的托管 endpoint 与 per-agent Entra identity。
- **central 拥有（不下放）**：跨后端的 Session identity、append-only event log（routing/replay/audit truth）、session 路由、authorization/audit、pause/resume 与恢复语义、client SDK 契约。

**sidecar 的命令通道保持 Web PubSub**（assign/turn/pause 照旧 push，和 Docker 完全一样）。Foundry 只是把容器托管起来；因为 Foundry 只跑「会应答它协议」的容器，sidecar 镜像额外实现一个**薄 Foundry 前门**（`/readiness` + 一个 boot/keepalive 的 `invocations` handler）。这个 invocation **只做 boot、保活、health，不承载命令**。

**Foundry 就是又一类 host-pool adapter，不是特例。** central / WorkerPoolManager 通过 `hostPoolControllerClass → registry.get(classId)` 解析到它，和 Docker 走**完全相同的泛型路径**，`src/` 里**不出现任何 `if (foundry)` 分支、不硬编码 Foundry 字符串、不写 fallback**。Foundry 只引入两个 self-declare `classId`、由 config 选择的 class：

- **central 侧 host-pool adapter**（`classId: foundry`，实现既有 `HostPoolAdapter`）：把 liveness invocation 的 open（用 client 选的 `agent_session_id`）/hold/close、terminate-session 全**封装在 `scaleOut`/`scaleIn` 内部**；由 `config/host-pool-controllers/*.json` 的 `adapterKind` 选择。
- **sidecar 侧 host adapter**（`classId: foundry`，和 `docker`/`local` 平级）：封装 sidecar 的引导来源与 liveness/health 前门；和 runtime transport 一样是 deployment 级选择，由 config 值经 registry 解析。

所有 Foundry 取值（`adapterKind`、`projectEndpoint`、`agentName`、`version`、cpu/mem、protocol、host class 等）都在 `config/` 与 `foundry/` 文档；pause 后是立即回收还是放任 idle 由 pool 的 scale/terminate 策略（config）决定，也不是分支。

## 2. 我们依赖的 Foundry 事实

| 维度 | 事实 |
| --- | --- |
| 定义/部署 | 一个 agent version = ACR **镜像** + `cpu`/`memory` + `protocol_versions`（我们用 `invocations`）+ 不可变 `environment_variables`；经 `agent.yaml` / SDK `create_version` / REST 创建。deploy = build/push 镜像 → create version → poll `active`。**code-as-agent（上传 zip 让平台构建）仅 Python/.NET**；我们 TS sidecar 走 **container 镜像**模式。镜像构建/部署 out-of-band，不进热路径。 |
| session ↔ container | 一个 Foundry **session id** = 一个 VM 隔离 sandbox。**client 用 `agent_session_id` query 参数直接指定/管理 session id**（实测：传 `?agent_session_id=w-x` → 响应头回显 `w-x`、session list 出现 `w-x`）。**同 session id → 同 container**（活跃期内存态存活；断线可用**同 id 重连**回它）；**跨 15min idle→resume → 新 container，仅 `$HOME` 被 restore**。 |
| 生命周期 | request-driven + **15min idle 自动 scale-to-zero**；**无 warm pool、无 always-on**。compute 由「第一个带该 session id 的 inbound 请求」懒启动。**idle 计时只被 endpoint 的 inbound 请求重置；Web PubSub 是 outbound，不算数、不重置。** session 最长 30 天。 |
| 平台注入 env | 容器运行时自动注入 `FOUNDRY_AGENT_SESSION_ID`（当前请求的 session id，容器因此知道自己是谁）、`FOUNDRY_PROJECT_ENDPOINT`、`FOUNDRY_AGENT_NAME`/`_VERSION`、`APPLICATIONINSIGHTS_CONNECTION_STRING`。 |
| env / secrets | 版本级 `environment_variables` **不可变**（给不了 per-worker 值）；secrets 用 project connection 占位符 `${{connections.<name>.credentials.<field>}}`，启动时解析注入。 |
| 容器约束 | 服务端口 **8088**；镜像必须 **linux/amd64**；必须暴露 **`/readiness`** 健康探针（TS 无一等协议库，需自实现）；invocations 端点 `POST {project}/agents/{name}/endpoint/protocols/invocations`（`api-version=v1`，header `Foundry-Features: HostedAgents=V1Preview`）。 |
| 会话管理 | 有 list / **stop**（停算力→`idle`，保留 session+`$HOME`，可同 id re-invoke）/ terminate（`DELETE`→`deleted`）session API；session 实测四态 `active`/`updating`/`idle`/`deleted`。sandbox 0.5/1/2 vCPU；`$HOME` ≤ 约 20 GiB；底座是 Azure Container Apps；endpoint 在 preview 阶段为公网。 |

由此固定的设计事实：**没有「预热一台 ready worker 挂着等 assign」**（compute 只在活跃期存在，cold start 落在首个 boot 请求）；**跨 idle 只保证 `$HOME`（状态）、不保证进程（compute）**，所以跨 idle 恢复的 baseline 是 restart-with-context。

## 3. 核心映射（1:1:1）

```text
我们的 Session  <->  一个 Foundry session id  <->  一个 Worker（capacity 1，生命周期归 Foundry）
```

一个 Foundry sandbox 只服务它自己那个 session，不复用给多个 session，所以三者 1:1:1。

| 我们的层 | Foundry 对应 | 说明 |
| --- | --- | --- |
| AgentSpec 的 launch 目标 | Foundry **agent(name+version)**（= 我们的 sidecar 镜像那一版） | 部署一次、所有 session 共享的镜像/端点 |
| WorkerPool | **并发配额 + 路由策略**（哪些 labels 的 session 走这个 Foundry agent、并发上限、terminate 策略） | 不是预热主机池 |
| Worker（capacity 1，生命周期归 Foundry） | 一个 Foundry session（跑我们的 sidecar 镜像）的容器 | 「注册」= sidecar 照旧 `/sidecar/negotiate` 反向注册 |
| Session | 当前绑定的 Foundry session id | resume/recovery 绑到**新的** session id（= worker 替换），identity 不变 |
| Event / WorkspaceSnapshot / Policy/Audit | 仍在我们这边 | 命令与事件走 Web PubSub；`$HOME` 由 sidecar 读本地打成 snapshot |

## 4. 生命周期：host-pool adapter 持有的 liveness invocation

Foundry 拥有容器生命周期，而 Web PubSub 命令是 outbound、不重置它的 idle 计时——所以要让 worker 活着，**Foundry host-pool adapter** 对该 Foundry session 的 endpoint **保持一条 liveness invocation**：

- **open** = 冷启容器 + 触发容器内 sidecar 起既有的 Web PubSub worker loop、反向注册；
- **持有** = 保活（SSE 长连 + 周期心跳字节，防 idle reap 也防 LB 掐空闲连接）；
- **close** = 让这个 worker 停（drain 信号）。

一条连接同时是「容器活着」的物理原因和「worker 该不该活」的租约。boot 与 keepalive 是**同一条** invocation。**已在 `proj-default` 实测：一条 held invocation 连续存活满 20 分钟（平台未主动切断，`boot_id` 全程不变）、稳定越过 15min idle 门槛而容器不被回收；反之一个无请求的 session ~15min 后确会被回收、换新容器（`boot_id` 变化）。** 所以长连保活成立。session id 是我们 **会话的耐久身份**：no-reuse pool 把每个 instance pin 到一个 session，adapter 取 `agent_session_id = 该 session 的稳定 workspaceRef`（不是 ephemeral 的 instanceId）并**持住那一条 liveness invocation**（单条实测 ≥ 20min）；**session id 由 client 用 `agent_session_id` query 参数控制**（实测确认），断线用**同一 id 重连**即回到同一 session/sandbox。**pause 不删 session（`durableAction=retain`：abort 连接 + `POST /stop` 停算力，session 转 `idle`——算力停、记录 + `$HOME` 原地保留），resume 时新 instance 携同一 workspaceRef re-invoke 该 `idle` session → 回到同 sandbox 的一个新容器代（`$HOME` 原样还在）；只有我们的 session 结束（`durableAction=release`）时 adapter 才 `terminate-session`（`DELETE session`）。** 这些全封装在 host-pool adapter 内部，对外仍是 `scaleOut`/`scaleIn` 契约（`scaleIn` 携一个 `durableAction`），central 不感知 Foundry。

| 维度 | Docker sidecar worker | Foundry sidecar worker |
| --- | --- | --- |
| 容器里跑什么 | 我们的 sidecar 镜像 | **同一个 sidecar 镜像** |
| 命令通道 | Web PubSub push | **一样（Web PubSub push）** |
| pause / 快照 | central→sidecar，读本地 `$HOME` 打快照 | **一样** |
| 谁拥有生命周期 | 我们：run 到我们 stop | **Foundry**：15min idle 回收、无 warm pool |
| 容器怎么起 | `docker run` | 对 endpoint open 一条 liveness invocation |
| 怎么保活 | 不需要 | **host-pool adapter 持有 liveness invocation**（Web PubSub 不算 endpoint 活动） |
| 怎么销毁 | `docker stop` | close liveness + `terminate-session` API |

## 5. Worker 引导：boot payload（E1）与 sidecar 的 boot 层

Foundry 版本级 env 不可变、给不了 per-worker 值，所以把 Docker 用 `-e` 传的 per-worker 引导放进 **liveness/boot invocation 的 JSON body**（Invocations 本就是任意 JSON）。分层：

| 配置类别 | 放哪 | 例子 |
| --- | --- | --- |
| 平台注入（免传） | Foundry 自动注入 env | `FOUNDRY_AGENT_SESSION_ID`、`FOUNDRY_PROJECT_ENDPOINT`、`PORT` |
| 版本级 env（部署稳定、非密） | Foundry agent version 的 `environment_variables`（镜像内亦可 `ENV`） | `SIDECAR_HOST_CLASS=foundry`、`COPILOT_MODEL`/`COPILOT_PROVIDER_TYPE`/`COPILOT_PROVIDER_BASE_URL` |
| per-worker 引导（非密） | **boot invocation payload** | `centralUrl`、`tenantId`、`workerPoolId`、`workerPoolInstanceId`、`workerTypeId`、`labels`、`capacity`（WPS 连接 URL 由 central `/sidecar/negotiate` grant 下发，不进 payload） |
| secrets | Foundry **project connection** 占位符 `${{connections...}}`（版本级，启动解析） | `GITHUB_TOKEN` 等 |
| Azure/WPS/provider 令牌 | sidecar 用 Foundry 分配的 **managed identity**（`DefaultAzureCredential`）现取 | provider bearer token |

引导来源由 **sidecar host adapter（`classId: foundry`）** 决定，不是运行时 `if`：Foundry host adapter 实现 `/readiness`，接住 liveness invocation → 从 boot payload 读引导 → 起既有 Web PubSub worker loop、`/sidecar/negotiate` 反向注册（带 `WORKER_POOL_INSTANCE_ID`）、持 SSE 心跳；`docker`/`local` host adapter 则从 env 读引导、不起 HTTP。二者由 config 值经 registry 选择，**命令路径不变**。correlation 照旧按 `WORKER_POOL_INSTANCE_ID`（必要时用注入的 `FOUNDRY_AGENT_SESSION_ID` 佐证）。

## 6. 运行流程

| 阶段 | 行为 |
| --- | --- |
| scale-out | queued session 匹配 Foundry（no-reuse）pool 时，central 为该 session scale 一个 **session-pinned instance**（带 `boundSessionId` + session 的稳定 `workspaceRef`）；Foundry host-pool adapter 取 `agent_session_id = 该 instance 的 workspaceRef` → **open 一条 `?agent_session_id=…` + boot payload 的 liveness invocation**（冷启容器）。容器内 sidecar 起 WPS loop、反向注册；central 照旧 pending→correlate→assign，且 correlate 时把 worker 预绑到该 session（只有它能被放上去）。 |
| assign / turn / interaction | 全走既有 **Web PubSub**，和 Docker 一样：assign 写 lease、turn push、interaction 往返，每条 event 带 `sessionLeaseId` fencing。 |
| pause | central→sidecar（WPS）→ 释放 lease → `paused`。Foundry 是 **host-managed 存储**（`copilot-local`/`LocalWorkspaceAdapter`，capture/restore 为 no-op），**不打快照**：worker 转 idle 后 host-pool adapter `scaleIn(durableAction=retain)` → **abort 那条 liveness invocation + `POST /stop` 停算力（session 从 `active` 经 `updating` 落到 `idle`）但不 delete session**，Foundry sandbox 连同 `$HOME` 原地保留（`idle` 只停算力、不删存储）。 |
| resume | session 重新 queued → central scale 一个**新的 session-pinned instance（同一个 `workspaceRef`）** → adapter 先 `POST /stop` 归一（把 not-exist/idle/active 三态收敛到无存活算力）再用**同 `agent_session_id`（= workspaceRef）**re-invoke 该 `idle` session → 回到**同一个 Foundry sandbox 的一个新容器代**，`$HOME` 原样还在（无需 restore）；新容器里 sidecar boot-once 反向注册（携新 instanceId）、correlate、新 lease、restart-with-context → running。 |
| session 结束 | session 到终态（cancelled/completed/failed）后其 worker recycle 时，central 解析出 `durableAction=release` → adapter `DELETE` 那个 Foundry session，释放 sandbox 存储。（若 session 在 **paused、已无活 worker** 时才结束，当前无主动清理钩子，该 Foundry session 靠 Foundry ~30 天 idle 过期回收——不占算力；显式 terminal 清扫留作后续。） |
| scale-in / idle | 空闲 worker：host-pool adapter `close liveness` + `terminate-session`（也可按策略放任 15min idle reap）。 |
| crash / 失联 | liveness 断线 → adapter 用**同 id 重连**（→ 同 sandbox）；重连持续失败或 heartbeat 丢失 → lease fencing → 按 recoveryPolicy 走 restart-with-context 或 non-recoverable failure。 |

## 7. 部署与定义（setup 放进 repo，`src/` 之外）

- **Foundry agent 定义**是 deploy-time 工件，不是 central runtime config，版本化在 repo 的 **`foundry/`**（`src/` 之外）：[foundry/README.md](../foundry/README.md) 记录部署步骤；镜像用 [containers/sidecar-foundry/Dockerfile](../containers/sidecar-foundry/Dockerfile)——它 `FROM` 基础 sidecar 镜像、只加 `ENV SIDECAR_HOST_CLASS=foundry`。部署走 **bring-your-own image**：`azd ai agent init --no-prompt --agent-name <name> --image <acr>/<img>:<tag> --protocol invocations --project-id <proj>` → `azd deploy`；复用同名 agent = 发新 version。
- **central runtime config** 与默认 Docker POC 同住一个 **`config/`** profile（host-pool adapter 是 config 选出的对等后端：一个 central 同时挂 Docker 池和 Foundry 池，靠 `storage` capability label 路由——`volume-snapshot` → Docker、`host-managed` → Foundry，互不冲突）；Foundry 三件套即：
  - [config/host-pool-controllers/foundry.json](../config/host-pool-controllers/foundry.json)：`id`、`adapterKind: "foundry"`、`projectEndpoint`、`agentName`、`workerType`（adapter 只读这几项；`workerType` 选 build profile，invocations endpoint 打的是 agent 的 **active version**，故无 `version` 字段；`projectEndpoint`/`agentName` 需指向你部署的 agent），外加 `centralUrlForWorkers`（Foundry 云 worker 回连 central 的公网地址，config store 按 controller 覆盖全局 `CENTRAL_URL_FOR_WORKERS` 默认；Docker worker 仍用 `host.docker.internal` 默认，与 adapter 字段分开读取）。
  - [config/worker-pools/foundry-copilot.json](../config/worker-pools/foundry-copilot.json) + [config/agent-specs/copilot-foundry.json](../config/agent-specs/copilot-foundry.json)。
- **worker-type / storage**：Foundry sandbox 无 Docker volume，故用 build profile **`copilot-local`**（`LocalWorkspaceAdapter`，storageClass = `host-managed`）；pool template 与 AgentSpec selector 都用 `storage: host-managed` 标签、配 `stop-on-pause`——契合 Foundry 空闲缩容到零 + restart-with-context 恢复。
- deploy 是 out-of-band（build/push 镜像 → create version → poll `active`），和 `pnpm build:sidecar-image` 一样不进 scale 热路径；一个 worker-type 镜像 = 一个 Foundry agent version，同 type 的多个 pool 共用它。
- 验证目标 project：`https://pmagent2.services.ai.azure.com/api/projects/proj-default`。

## 8. 状态权威与恢复语义

- **Foundry sandbox（`$HOME`）就是这个 session 的耐久 workspace**（host-managed 存储：`copilot-local`/`LocalWorkspaceAdapter`，capture/restore 为 no-op，不额外打快照）。pause = `POST /stop` 让 Foundry session 落到 `idle`（算力停、`$HOME` 原地保留）；resume = 同 `agent_session_id` re-invoke 该 `idle` session → 新容器代 + `$HOME` 原样还在。恢复 truth = 我们的 event log（routing/replay/audit）+ Foundry 保留的 `$HOME`（Copilot 私有 session 状态）。
- 恢复三态：**restart-with-context**（baseline：re-invoke 冷启新容器代，`$HOME` 原样 → Copilot 从本地状态 restart-with-context）／**true continuation**（可选优化：pause 后 worker 仍在 idle 窗口内未被 reap 时，resume 直接 reattach 存活 worker、无需 re-invoke）／**non-recoverable**（`$HOME` 丢失、AgentSpec 不兼容——显式暴露，不新建空 session 冒充恢复）。

## 9. Authorization and Audit

- 我们的 enforcement points（session create/connect/route/replay/artifact/worker 注册）不变；worker 的「注册」仍是 sidecar `/sidecar/negotiate`，进入 audit。
- Foundry host-pool adapter（在 tenant runtime 内）对 Foundry（open/close liveness、terminate-session）用 central 的 identity；`sidecar → Azure/WPS/provider` 用 Foundry 分配的 agent managed identity；非 Azure secrets 走 project connection。凭证不落镜像/payload 明文。Foundry RBAC 是纵深防御一层，不替代我们的 authorization 边界。

## 10. 不可替换的 invariant

Session identity 与生命周期核心状态机；Event envelope/ordering/cursor/idempotency；Worker 最小注册字段与 condition 语义；session lease fencing（旧 lease 写入必须被拒）；authorization/audit enforcement points；snapshot 必须绑定 event boundary。

## 11. 实现切片

按 [implementation-planning](../.github/skills/implementation-planning/SKILL.md) 拆成小、可评审、可回退的切片：

1. **sidecar host adapter（`foundry`）**：加 `/readiness` + liveness `invocations` handler（读 boot payload → 起既有 WPS worker loop + negotiate + 持 SSE 心跳），与 `docker`/`local` host adapter 同契约、由 config 选择。本地起容器、`curl :8088/invocations` 验证反向注册。
2. **Foundry host-pool adapter**：`scaleOut`＝allocate session id + open liveness invocation（boot payload）+ 持连；`scaleIn`＝close liveness + terminate session；correlate on negotiate。gated 真机 smoke（`RUN_FOUNDRY_WORKERPOOL_E2E`、`FOUNDRY_PROJECT_ENDPOINT`、`FOUNDRY_AGENT_NAME`，`az login`），非 secret 配置进 `tests/.env`。
3. **scale + assign + turn**：WorkerPoolManager 对 Foundry pool 走本 adapter，queued session 经既有 WPS 跑通 assign→turn→running。
4. **pause / resume**：pause＝WPS→sidecar→释放 lease→`paused`，worker 转 idle 后 host-pool adapter `scaleIn(retain)` = abort liveness + `POST /stop`（session→`idle`；host-managed 存储，capture/restore no-op，不打快照）；resume＝同 workspaceRef 的新 instance re-invoke 该 `idle` session（新容器代 + `$HOME` 原样，restart-with-context）。
5. **keepalive 韧性**：liveness 断线重连、Foundry 单请求上限前重建、central 重启后重建 liveness。
6. **部署工件（已实现）**：[containers/sidecar-foundry/Dockerfile](../containers/sidecar-foundry/Dockerfile)（`ENV SIDECAR_HOST_CLASS=foundry`）+ `config/` 里的 foundry 三件套（[config/host-pool-controllers/foundry.json](../config/host-pool-controllers/foundry.json) 等，与 Docker 同住 `config/`）+ 部署指南 [foundry/README.md](../foundry/README.md)；bring-your-own image：build/push 镜像 → `azd ai agent init --image` → `azd deploy`（复用同名 = 发新 version）。
7. **端到端演示**：`samples/webclient` + Playwright 驱动真实闭环（选 AgentSpec → Foundry pool scale → worker running → chat turn → pause）。

## 12. Validation（计划）

- 单元/契约：boot payload 解析、negotiate correlation、lease fencing、adapter 生命周期状态机。
- 真机 e2e：用真实 project（`pmagent2` / `proj-default`）+ `az login`，覆盖 open-liveness→boot→negotiate→assign→turn→pause(terminate)→resume。
- **关键验证（已完成，proj-default）**：用最小 Python invocations 探针实测——held invocation 连续存活 ≥20min、稳定抑制 15min idle reap；无请求 session ~15min 后被回收换新容器；cold start ~3.5s、warm ~2s；不同 session→不同容器、同 session→同容器。结论：长连保活可行。
- **central 侧已实现并验证（绿）**：sidecar `foundry` host adapter、central `FoundryHostPoolAdapter`（`scaleOut`＝取 `agent_session_id = 该 session-pinned instance 的 workspaceRef`，先 `POST /stop` 归一三态再 open `?agent_session_id=…` liveness invocation + 持一条连接、断线用同 id 重连；`scaleIn`＝abort liveness + 按 `durableAction`：`retain`（pause）`POST /stop`→`idle` 保留 session，`release`（结束）`DELETE` session）、no-reuse pool 的 session-pinned scale-out + correlate 预绑 worker + `resolveDurableAction`、`config/` 里与 Docker 同住的 foundry pool/spec/controller。契约单测（workspaceRef 作 session id / retain 停不删 / release 才删 / scaleOut stop-先-invoke / no-reuse pin）+ config 加载测全过；`pnpm typecheck`、`pnpm build`、`pnpm test` 全绿。
- **真机 gated e2e 已通过（`pmagent2/proj-default`）**：覆盖 boot→pause→resume→release 全闭环——scaleOut 建的 session 为 `active`；`retain` 的 `scaleIn`（pause）后 session 落到 **`idle`**（算力停、`$HOME` 保留，非 `active` 非 `deleted`）；用同一 `workspaceRef` 的新 instance re-invoke 该 `idle` session → 回到 `active`（新容器代、`last_accessed_at` 前进）= resume 冷启复用同 sandbox；`release` 的 `scaleIn`（session 结束）后变 `deleted`。**关键 API 澄清（实测 + 官方文档）**：Invocations 协议下 **client 用 `agent_session_id` query 参数直接管理 session id**、同 id 复用即同 session；`x-agent-session-id` 是平台**注入容器**的响应头，client 发的同名请求头**被忽略**。webclient 已实测默认展示 foundry AgentSpec/WorkerPool（无需改前端）。命令见 [AGENTS.md](../AGENTS.md)。
- **系统演示已通过（webclient + Playwright，真机 Foundry `pmagent2/proj-default`）**：devtunnel 暴露本地 central（公网 URL 写进 foundry controller 的 `centralUrlForWorkers`），部署的 `agent-runtime-sidecar` agent（镜像 `pmagent.azurecr.io/agent-runtime-sidecar-foundry`）在 Foundry 内 boot、经 tunnel 反向注册为 Worker、correlate→assign→running；**pause→idle-reap→resume 两轮都回到 running**（第一轮 client Pause 约 40s 冷启、第二轮 idle_timeout 自动 pause 约 16s 冷启），同一 durable session 每轮冷启到全新 worker、无卡 pending。

## 13. Non-goals

- 不把 sidecar 命令通道换成 invocation（命令仍走 Web PubSub）；invocation 只做 boot/keepalive/health。
- 不依赖 Foundry `$HOME`/conversation 作为唯一恢复 truth；不为 Foundry 引入绕过 lease/event log/auth 的 fast path。
- 不做 warm pool（平台无此原语，boot-on-demand）。
- 不把 Foundry 当 agent brain（用 Responses/Invocations 当模型编排是另一件事，不在本 spec）。
- 不把产品变成 model provider、agent framework、hosting platform、marketplace。

## 14. 待定问题

1. host-pool adapter 持有大量 liveness 长连的规模与重启恢复（central 进程重启后需重建各 worker 的 liveness）。
2. Foundry pool `capacity` 语义：并发 session 上限 + 成本护栏。
3. `agentStatePolicy` 的 true-continuation 边界：`$HOME` 之外，Copilot 私有 session 文件是否需额外处理。

## 15. 附录：Foundry Hosted-Agent 数据面 API（proj-default 实测确认）

以下端点/头在 `pmagent2/proj-default` 上用最小 invocations 探针实测确认，供 `FoundryHostPoolAdapter` 直接走 REST 调用（不经 azd）。

- **认证**：`Authorization: Bearer <token>`，token 用 `DefaultAzureCredential` 取 audience `https://ai.azure.com/.default`；所有请求带 `Foundry-Features: HostedAgents=V1Preview` 与 `api-version=v1`。
- **base** = `{projectEndpoint}/agents/{agentName}`。
- **boot / liveness 调用**：`POST {base}/endpoint/protocols/invocations?api-version=v1&agent_session_id=<id>`，头加 `Content-Type: application/json`，body 为任意 JSON（我们的 boot payload）。响应可为 `text/event-stream`（SSE，长连即保活）。
  - **session id 由 client 用 `agent_session_id` query 参数控制**（`pmagent2/proj-default` 实测 + [官方文档](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/concepts/hosted-agents)：Invocations 协议下「client 直接管理 session id」）：`POST …/invocations?api-version=v1&agent_session_id=<id>` → 响应头 `x-agent-session-id` 回显该 `<id>`、session list 出现该 `<id>`；**同 `<id>` 复用 → 同 session/sandbox**（实测两次同 id 返回同一 id、list 只一条）。省略 `agent_session_id` 时平台自动生成一个。容器内 `FOUNDRY_AGENT_SESSION_ID` = 该 id（= 我们的 `w-<instanceId>`，容器因此知道自己的 instance）。⚠️**坑**：`x-agent-session-id` 是平台**注入容器**用的头；client **发** `x-agent-session-id` 请求头会被**忽略**（session id 只认 `agent_session_id` query 参数）——曾误用该请求头导致误判。
- **列 session**：`GET {base}/endpoint/sessions?api-version=v1` → `{ data:[{ agent_session_id, version_indicator, status:"active"|"updating"|"idle"|"deleted", created_at, last_accessed_at, expires_at }], first_id, last_id, has_more }`（**实测四态**，非仅 active/deleted：`active`=算力在、`updating`=转移中的瞬态、`idle`=算力停但可复用、`deleted`=已删；状态转移是**最终一致**，要 poll 目标态别固定延时查一次；`created_at`/`last_accessed_at`/`expires_at` 是 **unix 秒**数字，别当 ISO 字符串 `Date.parse`）；`expires_at` = 创建 +30 天。
- **停 compute（保留 session 记录）**：`POST {base}/endpoint/sessions/{sessionId}/stop?api-version=v1` → 200；session 从 `active` 经短暂 `updating` 落到 **`idle`**（算力停、记录 + `$HOME` 保留）。**`idle` session 可被同 id `POST /invocations` 重新拉起 → 回到 `active`（`created_at`/`last_accessed_at` 前进 = 新容器代）**，这就是 pause→resume 冷启复用同 sandbox 的机制（实测确认）。
- **删 session（terminate）**：`DELETE {base}/endpoint/sessions/{sessionId}?api-version=v1` → 200，status 变 `deleted`（eventual）。
- 平台标识（响应头）：`x-platform-server: azure-ai-agentserver-core/2.0.0b7 (python/3.13)`；`Api-Supported-Versions: 1.0, 2025-05-15-preview, 2025-11-15-preview`。
- 容器契约：服务端口 8088，`GET /readiness` → 200，镜像 linux/amd64；code-deploy（zip 平台构建）仅 Python/.NET，TS sidecar 走 container 镜像。

`FoundryHostPoolAdapter` 用法（已按实测修正）：`scaleOut` = `sessionId = 该 session-pinned instance 的 workspaceRef` → 先 `POST …/sessions/{sessionId}/stop` **归一**（把 not-exist/idle/active 三态收敛到无存活算力，避免 re-invoke 撞上仍热的旧容器 + 旧 instanceId 的 boot-once sidecar）→ 再 `POST …/invocations?api-version=v1&agent_session_id=<sessionId>` + boot payload → 返回 `containerId = sessionId` → **持有该条请求**读 SSE 保活（单条实测 ≥ 20min）；断线用**同一 `agent_session_id` 重连**。`scaleIn` = abort 持有的请求 + await keepalive loop 结束（防重连再建）+ 按 `durableAction`：`retain`（pause）→ `POST …/sessions/{sessionId}/stop`（session → `idle`，保留 sandbox 供 resume），`release`（结束）→ `DELETE …/sessions/{sessionId}`（status → `deleted`）。真机 gated e2e 断言全闭环：boot→`active`、pause(retain)→`idle`、同 workspaceRef re-invoke→`active`（新代）、release→`deleted`。
