# Agent Runtime Sidecar Overall Spec：从可运行切片到生产化 Runtime

状态：架构讨论稿  
日期：2026-06-22  
读者：架构师、runtime owner、SDK/API owner、平台工程 owner

## 1. 文档目的

这份 spec 的目标不是重新列一遍 component 名字，而是回答架构讨论里一定会出现的三个问题：

1. **这到底是什么？** 这是一个把 stateful、interactive agent session 运行成 durable online service 的 runtime layer。它不替代 agent framework、model provider 或 cloud hosting platform，而是在这些系统之间提供 session identity、routing、reconnect、workspace persistence、recovery、authorization 和 audit。
2. **为什么需要它？** 当 agent 从本地 CLI、IDE、聊天窗口进入 application backend 和 online service 调用链以后，session 不能再只存在于某个 worker process 的内存里。应用需要一个稳定服务入口，用户需要一段可恢复、可追溯的连续工作，平台需要权限、租户边界和审计。
3. **每个部分先做什么，后做什么？** V1 要先验证一个已有 agent 能通过 sidecar 接入同质化 worker pool，并以 durable、interactive、self-hostable service 的方式运行。之后再扩展 cluster、异构环境、protocol adapter、managed service 和更强的 context portability。

本文以 [agent-runtime-sidecar-brief-ch.md](agent-runtime-sidecar-brief-ch.md) 和 [agent-runtime-sidecar-brief-en.md](agent-runtime-sidecar-brief-en.md) 作为当前产品边界。旧项目 `C:\Users\chenyl\conduit` 是重要设计输入，但不是实现基线，也不是迁移兼容目标。

## 2. 核心判断

Agent Runtime Sidecar 的核心判断是：**session 是 durable identity，worker 是 replaceable compute**。

这句话决定了整个系统的先后顺序。我们不能先做一个很聪明的 worker scheduler，再把 session persistence 补进去；也不能先做复杂 agent protocol，再让 application team 自己承担 session catalog 和 authorization。正确的起点是先把 session 定义成可运营对象，再让 worker、sidecar、storage、SDK 和治理能力围绕它工作。

一个 session 至少要回答这些问题：

- 它属于哪个 tenant、owner、principal 或 application？
- 它处于 created、running、awaiting input、recovering、failed、completed、deleted 等哪个 lifecycle state？
- 它当前由哪个 worker 服务？如果 worker 消失，哪些 worker 可以接手？
- 它的用户可见事件、workspace snapshot、artifact 和 audit record 存在哪里？
- 哪些主体可以创建、连接、发送消息、replay event、访问 artifact、注册 worker 或触发 recovery？
- 它的恢复是 true continuation、restart with context，还是明确不可恢复？

如果这些问题没有先被建模，后续 component 再完整也会变成一组分散工具。架构上最重要的不是 sidecar、storage 或 SDK 单独存在，而是它们共同服务于 session continuity 和 session governance。

## 3. 与旧 Conduit 的关系

旧 Conduit 已经验证过一些非常有价值的设计事实：session 和 compute 可以分离，client 可以通过 SDK 消费 session lifecycle 和 event stream，event log 可以成为恢复和 replay 的基础，conformance test 可以把 wire contract 固定下来。这些经验应该继承。

但新产品不能把旧 Conduit 直接搬过来。旧 Conduit 的重心更接近 host-centric control plane：本机 host 管 session、provider、tokens、profiles、workspace、tunnel、session process 和环境 RPC。Agent Runtime Sidecar 的重心更靠近 application-facing durable session runtime：central session service 是公开服务入口，sidecar 适配已有 agent process，storage 保存 session/workspace/event/audit，权限检查进入 routing path。

| 旧 Conduit 经验 | 可以继承什么 | 需要调整什么 | V1 不应继承什么 |
| --- | --- | --- | --- |
| Host 管理 session lifecycle、event bus、diagnostics、workspace 和 compute | durable session 与 ephemeral compute 分离；snapshot 加 cursor stream 的客户端体验 | 从 host-centric 变成 central service-centric，client 默认面向 session service 而不是直接记住 compute endpoint | 本机 mesh、Dev Tunnels discovery、host-to-host federation 作为 V1 主线 |
| Session process 暴露 `fs.*`、`terminal.*`、`git.*`、`agent.*` 等 JSON-RPC service | session event log、checkpoint/restore、capability discovery、adapter composition | 新 sidecar 应先包住已有 agent process，而不是要求 agent 变成完整 session platform | 把 V1 做成通用 remote IDE/runtime RPC 标准库 |
| Typed agent event vocabulary 和 schema versioning | canonical event、schema discipline、SDK 边界校验、conformance fixture | 先定义小而稳定的 runtime event model，再按需求扩大 agent semantic event | 过早标准化统一 semantic context schema |
| Client SDK 支持 snapshot 加 cursor stream、live list、reconnect | SDK 隐藏连接、replay、stream 细节，应用不用手写 gateway | 拆成 client SDK、backend API、sidecar API 三类使用者 | 让 SDK 绕过 central authorization 直接和 worker 形成长期耦合 |
| CMDB、provider proxy、token、profile、artifact governance | 配置注入、secret 不暴露给 client、audit hook 这些思想有价值 | V1 只保留 agent runtime 所需配置和权限边界 | 把产品扩成 model provider gateway、enterprise CMDB 或 agent builder |
| Cloud prototype、Aspire、本地/云组合运行 | self-hostable development mode 和 production cluster mode 的交付路径 | 新设计应先明确 central state 和 worker pool，再考虑部署实现 | 假设旧 cloud API shape 就是新服务 contract |

旧 Conduit 给我们的最大提醒是：一旦产品同时承担 provider、CMDB、remote desktop、mesh、session runtime 和 agent adapter，边界会迅速变宽。新设计要把 runtime 问题先做深，而不是把所有相邻平台能力都吸进 V1。

## 4. 产品边界

V1 的一句话边界是：

> 让一个已有 agent 通过 process-wrapper sidecar 接入同质化 worker pool，并作为 durable、interactive、tenant-aware online session 被 application 调用。

这里的“已有 agent”可以是 CLI agent、本地 process、framework-based agent，或者已经能在 worker image 中启动的 agent harness。V1 不要求客户重写 agent loop，也不要求客户先采用新的 agent framework。

这里的“同质化 worker pool”表示同一类 agent worker 彼此兼容：相同或可验证兼容的 agent type、tool surface、workspace preparation、runtime config 和 sidecar protocol。V1 先在这个假设下验证 routing、reconnect、recovery 和 auth/audit，因为这是最能证明 durable session runtime 价值的场景。

V1 明确不做：

- 不做 model provider，不负责训练、托管或选择模型。
- 不做完整 agent framework，不定义 agent loop 应该如何思考或调用工具。
- 不做通用 hosting platform，不替代 Kubernetes、container platform 或 VM scheduler。
- 不做 marketplace、full management UI 或 general application builder。
- 不急于定义跨所有 agent 的统一 semantic context format。
- 不把 personal device、edge device、企业内网机器和 cloud worker 的异构 routing 放进第一阶段。

这些 non-goal 不是说永远不做，而是说它们不能阻塞第一条产品主线：durable session runtime。

## 5. Durable Object Model

在讨论 component 之前，先要确定 runtime 里哪些对象是稳定对象。component 是这些对象的管理边界，而不是设计的起点。

| 对象 | 是什么 | 为什么要有这个对象 | V1 先做到什么 | 后续再扩展什么 |
| --- | --- | --- | --- | --- |
| Session | 用户或 application 看到的一段 durable agent work | 它把 identity、status、history、workspace、access policy 和 lifecycle 绑在一起，使 client 不依赖 worker 地址 | session ID、owner/tenant、status、active worker、event cursor、workspace pointer、access policy pointer | session search、retention policy、cross-region metadata、advanced lifecycle analytics |
| Agent type | 一类兼容 worker 和 sidecar 能服务的 agent | recovery 和 routing 不能只看“有空 worker”，还要看 worker 是否能正确接续这个 session | agent type ID、config version、required capabilities、workspace contract、recovery mode | capability-based routing、multi-version rollout、canary agent type |
| Worker | 可替换的 compute instance | worker 会重启、扩缩容、失败，不应成为 session identity | worker registration、heartbeat、capacity、agent type support、current session bindings | autoscaling signal、placement policy、zone awareness |
| Sidecar | 靠近 agent process 的 runtime adapter | 它让已有 agent process 进入 session runtime，同时隔离 central service 和 agent 内部实现 | process wrapper、workspace prep、event translation、status report、snapshot submission | SDK adapter、local HTTP/gRPC/stdio 多协议 bridge、tool permission mediation |
| Runtime event | session 内发生的可 replay 事实 | reconnect、audit、debug、recovery 都依赖事件，而不是依赖 transient log | append-only event log，覆盖 input、output、tool、approval、status、error、lifecycle | schema registry、event compaction、semantic timeline、cross-session analytics |
| Workspace snapshot | agent 工作现场的可恢复副本 | 对 coding/data agent 来说，真实状态常在文件、artifact、log 和中间产物里 | snapshot metadata、content location、createdAt、base event index、restore compatibility | incremental snapshot、dedupe、branch/worktree strategy、large workspace policy |
| Artifact | 用户或系统需要长期保留的输出 | artifact 需要访问控制、下载、审计和引用，不应只混在 workspace 目录里 | artifact reference、session binding、content type、storage location、access check | artifact lineage、promotion、cross-session reuse |
| Principal and policy | 调用者身份及其被授权的动作 | central service 是 public-facing endpoint，不能把权限只放在 application backend | tenant、principal、role/capability、session access check、worker registration check | application-provided policy hook、enterprise policy integration |
| Audit record | 谁在什么时候对什么做了什么 | session runtime 会承载企业工作流和敏感 workspace，必须可追溯 | create/connect/route/replay/artifact/worker registration/authorization failure | SIEM export、retention controls、compliance reporting |

这张表也定义了架构实现的先后顺序：先把对象契约和 lifecycle 定住，再决定每个 component 如何存、路由、暴露和验证它们。

## 6. 目标架构

V1 的目标架构由四个主边界组成：central session service、agent runtime sidecar、persistent storage、SDK/API。Authorization、audit 和 observability 不是第五个“可选组件”，而是穿过这些边界的控制面能力。

```text
Client / App Backend
        |
        | HTTPS / WebSocket / SSE
        v
Central Session Service
        |
        | Routed event channel / control channel
        v
Agent Runtime Sidecar
        |
        | Process / stdio / local HTTP / SDK bridge
        v
Existing Agent Process / Agent Harness

Persistent Storage:
- Session catalog
- Worker registry state
- Append-only event log
- Workspace snapshots
- Artifacts
- Runtime metadata
- Audit records
```

Central session service 是应用和用户面对的稳定入口。它不应该把 worker endpoint 泄漏成 public contract。client 或 app backend 只需要持有 session ID，并通过 central service 创建、连接、发送输入、接收输出、replay history、访问 artifact。Central service 在这些路径上做 authorization、routing、connection state、audit 和 session lifecycle transition。

Sidecar 是 worker 内部靠近 agent process 的适配层。它的第一价值不是“更优雅的 agent framework”，而是降低接入成本：客户已有 agent 只要能被 process wrapper 启动、能通过 stdio/log/API 交换输入输出，就能先进入 runtime。Sidecar 负责把 central service 的 session event 转成 agent 可理解的输入，把 agent output、tool event、permission request、status 和 checkpoint 写回 central service。

Persistent storage 是 continuity 的基础。它要保存的是可以恢复和解释 session 的材料，而不是所有 agent 内部状态的完美镜像。V1 应该诚实承认：event log 加 workspace snapshot 可以恢复用户可见历史和工作现场，但并不自动等价于恢复模型内部上下文、未完成 tool call 或 agent 私有 memory。

SDK/API 是产品使用边界。Client SDK 让 UI 或 CLI 不必手写 reconnect 和 event replay。Backend API 让 application server 代表用户创建 session、管理 policy、查询状态。Sidecar API 让 worker 注册能力、接收 routed event、上报状态、提交 snapshot。三类接口必须共享同一套 session model，但权限和职责不同。

## 7. 整体实施顺序

实施顺序应围绕一个 vertical slice 展开：先跑通一个已有 agent 的 durable session，再扩展可靠性、治理和规模。每个阶段都应该产生可讨论、可测试、可替换的 contract。

| 阶段 | 要回答的架构问题 | 先做什么 | 先不做什么 | 退出标准 |
| --- | --- | --- | --- | --- |
| Phase 0：契约和场景冻结 | V1 到底验证哪个客户场景？哪些对象是 durable？ | 固定 coding/developer-tool agent 或另一个 workspace-heavy agent 作为首个场景；定义 session、agent type、worker、event、snapshot、artifact、audit 的最小 schema；写清 non-goals | 不选多个垂直行业同时验证；不讨论 managed service 商业化 | 架构师能用同一套词解释 session、worker、sidecar、recovery mode 和 auth path |
| Phase 1：单机 self-hosted vertical slice | 一个已有 agent 能不能以最小改造接入 runtime？ | 单 central service instance；process-wrapper sidecar；agent type registration；create session；attach worker；basic event stream；workspace preparation；manual cancel/stop | 不做 cluster scheduler；不做复杂 UI；不做异构 worker；不做 semantic context schema | 用户能创建 session、看到流式输出、中途输入或 approve、断开后按 event cursor 追上历史 |
| Phase 2：durable routing 和 reconnect | session 能不能独立于 worker endpoint 被访问？ | durable session catalog；worker heartbeat/capacity；active worker binding；session-aware routing；client reconnect；event replay；basic idempotency | 不做多区域；不做复杂 placement policy；不让 client 直连 worker 成为 public contract | client 只持有 session ID；worker 重启或 client 断线不会让 session 从列表消失 |
| Phase 3：persistence 和 recovery honesty | worker 失败以后系统能恢复什么，不能恢复什么？ | append-only event log；workspace snapshot；artifact storage；runtime metadata；recoverable/failed state；true continuation 和 restart with context 的显式区分 | 不声称任意 agent 都能无损恢复；不做统一语义上下文标准 | worker failure 后，系统能选择 compatible worker，恢复 workspace，replay 必要事件，并向用户说明恢复模式 |
| Phase 4：authorization、tenant isolation 和 audit | 这个 runtime 能不能安全进入 application 调用链？ | tenant/principal/session role model；create/connect/route/replay/artifact/worker registration 的权限检查；audit record；application-provided authorization hook 的最小形态 | 不做完整 enterprise policy engine；不把权限只交给调用方 app server | 每条关键路径都有明确 allow/deny 结果和 audit trail；越权 route 和 artifact access 被拒绝 |
| Phase 5：production self-hosted cluster | 单机模型能不能进入客户自有生产环境？ | shared session catalog；shared event log 或 broker；shared workspace/artifact storage；multi-instance central service；worker pool deployment；health/metrics/tracing | 不先做 managed cloud；不支持跨环境 edge routing | central service 可以水平扩展；worker pool 可以滚动重启；session metadata 和 event 不依赖单机磁盘 |
| Phase 6：扩展生态和高级能力 | 哪些能力在核心 runtime 被验证后值得加？ | protocol adapter、multi-language SDK、admin UI、semantic context experiments、heterogeneous connector、managed service | 不让扩展能力改变 V1 session/runtime model | 新能力作为 adapter 或部署形态加入，不重写 session identity 和 routing 语义 |

这个顺序的关键是：**先证明 runtime mainline，再扩大平台边界**。如果 Phase 1 到 Phase 3 没有跑通，后面的 protocol compatibility、UI、managed service 都会建立在不稳定的 session model 上。

## 8. Central Session Service：先定义 session control plane，再扩展调度

Central session service 是最容易被误解的部分。它不是普通 API gateway，也不是单纯 WebSocket server。它是 session control plane 和 communication entry point。

它先要做的事情是让 session 成为可寻址、可授权、可路由、可恢复的对象：

- 定义 session catalog：session ID、tenant、owner、agent type、status、active worker、event cursor、workspace pointer、createdAt、updatedAt、lifecycle reason。
- 定义 worker registry：worker ID、agent type support、capabilities、heartbeat、capacity、version、current bindings。
- 定义 routing decision：新消息进入后，central service 判断 principal 是否有权限、session 是否可接收输入、active worker 是否有效、是否需要进入 recovery。
- 定义 connection state：client attach/detach、sidecar attach/detach、stream cursor、backpressure 基本策略。
- 定义 lifecycle transition：created、queued、starting、running、awaiting input、recovering、failed、completed、deleted 等状态的合法迁移。

这些能力应该先于复杂 scheduler。架构师可能会问：“为什么不一开始就做 Kubernetes style scheduler？”答案是，V1 的风险不在于找不到一台机器，而在于系统是否能把一条 session 的身份、权限、事件和 workspace 与 worker 解耦。调度策略可以后置，routing contract 不能后置。

Central service 后续再做：

- 更复杂的 placement policy，例如 zone、cost、data locality、tenant quota。
- worker drain、rolling upgrade、agent type canary。
- 多实例 coordination、distributed lock 或 lease。
- session search、fleet-level dashboard、跨区域复制。

会议上需要重点讨论：active worker binding 是强 lease 还是可抢占 assignment；消息路由是否需要 exactly-once 语义，还是通过 event idempotency 提供 at-least-once 加去重；worker heartbeat 超时后如何避免两个 worker 同时写同一 session。

## 9. Agent Runtime Sidecar：先 process wrapper，再 richer adapter

Sidecar 的存在是为了避免把客户挡在“必须重写 agent loop”之前。它应该先做 process-wrapper，而不是先设计一个理想的 agent SDK。

Process-wrapper sidecar 先要做到：

- 启动或 attach 到已有 agent process，管理 process lifecycle、exit code、stdout/stderr、stdin 或本地 API。
- 准备 workspace：创建目录、拉取或恢复 workspace snapshot、写入必要 runtime config、注入 session metadata。
- 把 central service 的 user input、approval、cancel、system event 转给 agent。
- 把 agent output、tool event、permission request、status、error、checkpoint signal 转成 runtime event。
- 定期上报 sidecar health、agent health、capacity 和 snapshot/checkpoint 状态。
- 在取消、超时或 worker drain 时，让 agent 有可解释的停止路径。

为什么先这样做？因为最早客户已经有 agent investment。产品价值不是让他们先学一个新 framework，而是把现有 agent 放进 durable session runtime。旧 Conduit 的 session SDK 证明了完整 session process 能力很强，但新设计的 wedge 应该更低：先 wrapper，再逐步变成 adapter SDK。

Sidecar 后续再做：

- local HTTP、gRPC、stdio、named pipe、socket 等多种 agent bridge。
- framework-specific adapter，例如 Copilot、Claude、LangGraph、AutoGen 或客户自研 harness。
- structured capability discovery、tool permission mediation、MCP server lifecycle。
- richer checkpoint protocol，例如 agent 主动声明可恢复点、压缩摘要、未完成 tool call 状态。

会议上需要重点讨论：process-wrapper 如何识别 structured event；如果只能读 stdout，哪些能力只能 best effort；sidecar 是否可以强制 agent 在每个 turn 后产生 checkpoint；当 agent 阻塞等待用户输入或 tool approval 时，central service 如何知道 session 是 awaiting input 而不是 hung。

## 10. Persistent Storage：先保存可解释恢复材料，再追求完整语义可移植

Storage 的第一职责不是成为万能 memory system，而是保存 session continuity 的证据和工作现场。

V1 先需要四类 storage contract：

1. **Session catalog**：服务于 list、connect、route、recover、delete。它需要事务性地记录 lifecycle state 和 active worker binding。
2. **Event log**：append-only，带 event ID、session ID、type、schema version、actor、timestamp、causality/correlation ID、payload、visibility 或 audit marker。它支撑 replay、debug、reconnect 和部分恢复。
3. **Workspace snapshot and artifact storage**：保存文件、日志、中间产物和用户可下载输出。snapshot 需要标记它对应到哪个 event index 或 checkpoint boundary。
4. **Audit records**：保存安全关键路径上的访问和决策，不能只依赖普通 debug log。

V1 不需要先发明统一 semantic context schema。这个判断很重要。不同 agent framework 的内部上下文、memory、tool state、conversation compaction 都不同。把它们过早统一，会让 runtime 变成 agent framework 竞争区。更稳的路径是先保存 runtime 可观测事实和 workspace，再让 adapter 明确声明自己支持哪种 recovery。

后续可以扩展：

- incremental snapshot、content-addressed storage、large workspace retention。
- event schema registry 和 projection-time migration。
- session summary、semantic checkpoint、bounded model-visible context。
- cross-session artifact lineage 和 compliance retention。

会议上需要重点讨论：event append 和 workspace snapshot 的一致性边界。比如 snapshot 成功但 event append 失败，或者 event 已提交但 snapshot 上传失败，session 应进入什么状态？这些不是实现细节，而是 recovery semantics 的一部分。

## 11. SDK/API：先固定三类使用者，再扩语言和 protocol

SDK/API 不能只服务 client UI。这个 runtime 至少有三类调用者：client、application backend、sidecar。它们都围绕 session，但权限和职责不同。

Client SDK/API 先做：

- create 或 request session，具体是否允许由 backend 和 auth policy 决定。
- connect session，接收 snapshot 加 cursor stream。
- send user input、approval、cancel、correction。
- replay event、resume stream、查询 artifact metadata。

Backend API 先做：

- 代表用户创建 session，绑定 tenant、owner、agent type、initial workspace、initial policy。
- 查询 session state、列出用户可见 session、管理 access policy。
- 提供 authorization hook 或 policy decision integration。

Sidecar API 先做：

- worker registration、capability advertisement、heartbeat、capacity report。
- lease 或 assignment 接收。
- routed event receive、runtime event append、status update、snapshot submit。
- graceful drain、shutdown、recover request。

这些 API 的顺序应该是 contract first。旧 Conduit 的 conformance suite 经验值得继承：wire-level contract、event shape、error code、cursor replay、lifecycle transition 都要有公共行为测试。新 repo 目前还没有代码和验证命令，所以 spec 阶段不要声称已有 build/test/lint 保障；等实现出现后，再把验证命令写回 repo 指令。

后续再做：

- TypeScript 之外的 C#、Python、Go SDK。
- AG-UI、A2A、MCP、ACP 等 protocol adapter。
- higher-level UI components、recorder、test harness。

会议上需要重点讨论：哪些字段属于 stable public contract，哪些只是 diagnostic；错误是否可机器处理；SDK 是否应该隐藏 routing/reconnect，但不能隐藏 authorization denial 和 recovery mode。

## 12. Authorization、Tenant Isolation 和 Audit：先放进关键路径，不后补

Authorization 不能等到 runtime 能跑以后再补。原因很简单：central session service 会成为 public-facing endpoint。如果创建 session、连接 session、发送消息、event replay、artifact access 和 worker registration 一开始没有权限边界，后续再加会改变 API contract 和数据模型。

V1 先定义一个足够小的 authorization model：

- Tenant：数据和 worker pool 的隔离边界。
- Principal：用户、service account、application backend、sidecar worker。
- Resource：agent type、session、workspace snapshot、artifact、worker registration。
- Action：create、connect、send、approve、cancel、replay、read artifact、register worker、recover、delete。
- Role/capability：把常见权限组合成可读规则。
- Application authorization hook：允许客户业务系统参与决策，但 central service 仍负责执行结果。

Audit 先覆盖安全关键路径：

- session creation、connection、disconnection。
- message routing、approval、cancel。
- event replay 和 artifact access。
- worker registration、assignment、recovery。
- authorization failure 和 policy hook failure。

后续再扩展 enterprise policy engine、fine-grained tool policy、SIEM export、compliance report。V1 不需要成为通用企业策略平台，但必须让每条关键路径都有明确的 allow/deny 和 audit record。

会议上需要重点讨论：worker 是否代表 tenant 内可信 compute；sidecar credential 如何轮换；application-provided hook 超时或失败时默认 deny 还是 fail open。对生产 runtime 来说，这些都是产品语义，不只是运维配置。

## 13. 关键运行流程

### 13.1 Create and Start Session

先实现的流程：application backend 或 client 请求创建 session。Central service 验证 principal，创建 session record，选择 agent type，找到可用 worker 或等待 worker。Sidecar 接到 assignment 后准备 workspace，启动 agent process，报告 ready。用户输入和 agent 输出都以 event 进入 central service。

后续扩展的流程：队列化启动、复杂 placement、quota、priority、pre-warmed worker、multi-tenant capacity reservation。

架构讨论重点：session record 应在 worker ready 前创建，因为 session identity 不能依赖 worker 启动成功。worker 启动失败应成为 lifecycle event，而不是让 create request 悄悄消失。

### 13.2 Client Reconnect

先实现的流程：client 使用 session ID 重新连接 central service。Central service 做 authorization，返回 session snapshot 和 event cursor，从 cursor 开始 replay 或 stream。client 不需要知道 active worker endpoint。

后续扩展的流程：多 client presence、collaboration role、cursor retention、offline notification、partial transcript projection。

架构讨论重点：event replay 是用户体验的一部分，不是 debug feature。cursor 过期时必须有明确行为：返回需要 fresh snapshot，而不是让 client 猜测状态。

### 13.3 Worker Failure and Recovery

先实现的流程：heartbeat 超时或 sidecar 报告 failure 后，central service 将 session 标记为 recovering 或 failed。若 agent type、config version、workspace snapshot、event log 和 adapter capability 满足条件，则选择 compatible worker。新 sidecar 拉取 snapshot 和必要 event context，按 adapter 声明的模式恢复。

后续扩展的流程：自动重试策略、zone failover、incremental checkpoint、未完成 tool call repair、operator intervention UI。

架构讨论重点：不要把所有恢复都叫 resume。V1 应明确三种语义：

- **True continuation**：agent adapter 能恢复内部状态或足够精确的 checkpoint，用户可以认为同一 turn 连续进行。
- **Restart with context**：runtime 恢复 workspace 和 history，让 agent 重新进入任务，但不保证内部状态无损。
- **Non-recoverable failure**：缺少 snapshot、agent type 不兼容、tool state 不可恢复，系统只能展示失败和已有 artifact。

### 13.4 Approval and Human-in-the-loop

先实现的流程：agent 通过 sidecar 发出 permission request 或 user input request。Central service 持久化 request event，通知有权限的 client。client response 经过 authorization 后路由回 sidecar。request completion 也写入 event log。

后续扩展的流程：approval delegation、timeout policy、multi-approver、tool-specific policy、location-scoped approval。

架构讨论重点：approval 不能只是 worker 内存里的 pending promise。否则 client 断线、worker failure 或 audit review 时都无法解释系统状态。

### 13.5 Artifact Access

先实现的流程：sidecar 或 agent 产生 artifact reference。Central service 存储 artifact metadata，artifact content 进入 object storage 或 workspace snapshot。用户访问 artifact 时经过 session/artifact authorization，并记录 audit。

后续扩展的流程：artifact promotion、sharing、retention policy、content scanning、lineage。

架构讨论重点：artifact 不是“文件下载小功能”。它是 session 输出进入应用和企业流程的边界，必须从第一版就有 ownership 和 audit。

## 14. Recovery Semantics

Recovery 是最容易被过度承诺的部分。V1 的目标不是保证所有 agent 在所有情况下无损恢复，而是保证 runtime 能保存足够材料，并诚实表达恢复等级。

V1 的恢复判断可以按顺序执行：

1. Session 是否存在，且状态允许 recovery？
2. 当前 principal 或 system actor 是否有 recover 权限？
3. 是否存在可用 workspace snapshot？它对应的 event index 是多少？
4. 是否存在 compatible worker？agent type、config version、required capability 是否匹配？
5. Adapter 是否声明支持 true continuation 或 restart with context？
6. 是否存在未完成 approval、tool call、file operation 或 external side effect？如果存在，如何向用户展示？

恢复成功后，系统应该写入 recovery event，说明 source worker、target worker、snapshot ID、event index、recovery mode 和任何降级原因。恢复失败也应该是 session lifecycle 的可见状态，而不是普通 error log。

后续如果要做 semantic context portability，也应该作为恢复能力的增强项，而不是 V1 的先决条件。否则 runtime 会被迫理解每个 agent framework 的私有记忆、压缩策略和 prompt assembly。

## 15. Observability and Operations

V1 的 observability 先围绕 session 和 worker，而不是围绕 generic infrastructure metrics。

先做：

- session state timeline：created、assigned、started、input received、agent active、awaiting approval、snapshot created、recovering、completed、failed。
- worker health：registered、heartbeat、capacity、assigned sessions、last failure。
- event ingestion health：append latency、stream cursor、replay failure、event retention。
- snapshot health：snapshot started、completed、failed、size、duration、base event index。
- authorization and audit health：allow/deny count、hook latency、audit write failure。

后续再做完整 admin UI、fleet dashboard、SLO、cost analytics、cross-session search。旧 Conduit 的 diagnostics 和 event bus 经验可以借鉴，但新 runtime 首先要形成 session-level view，让 application 和 operator 都能回答“这段 agent work 到哪一步了”。

## 16. Deployment Path

交付顺序应该是 self-hostable first。

第一步是 **single-instance development mode**：一个 central service instance，本地或嵌入式 metadata storage，本地 workspace/artifact storage，一个或多个 sidecar worker。它服务 demo、开发和早期客户验证。这个模式要尽量低摩擦，因为 V1 需要快速证明已有 agent 能接入。

第二步是 **production cluster mode**：central service 多实例部署在 load balancer 后面，共享 session catalog、event log 或 broker、workspace/object storage、worker registry 和 audit storage。这个阶段必须完成 tenant-aware auth、authorization、audit、health 和 backup/restore。

第三步才是 **managed service**：如果 self-hosted adoption 证明客户需要这个 runtime，但不想长期运维 control plane，再提供 managed cloud service。Managed service 应复用同一 session model，不应该变成另一个产品。

旧 Conduit 的本地 host 体验说明低摩擦启动很重要，但新产品的生产目标不是每台机器一个独立 host mesh，而是 central state 加 replaceable worker pool。

## 17. Validation Matrix

这个 spec 的实现计划应该用业务行为和 public contract 来验证，而不是检查私有 helper 或源码结构。

| 验证项 | 应证明什么 | 最小验收方式 |
| --- | --- | --- |
| Existing agent integration | process-wrapper sidecar 能接入已有 agent | 启动一个真实或 reference agent，创建 session，发送输入，收到流式 output |
| Durable session catalog | session 不依赖 worker 内存 | 停止 client 后重新列出和连接同一 session |
| Reconnect and replay | client 可以用 cursor 补齐历史 | 断开连接，产生新 event，重连后从上次 cursor replay |
| Routing boundary | client 不需要 worker endpoint | 只用 session ID 经 central service 发送消息 |
| Worker failure recovery | worker 可替换，恢复语义可解释 | 杀掉 worker，选择 compatible worker，恢复 workspace，并写 recovery event |
| Authorization | critical path 有 allow/deny | 未授权 principal 无法 connect、send、replay 或 read artifact |
| Audit | 安全关键动作可追溯 | create/connect/route/replay/artifact/worker registration 有 audit record |
| Workspace snapshot | 工作现场可恢复 | agent 修改 workspace 后 snapshot，恢复到新 worker 可看到文件状态 |
| Artifact access | 输出进入应用边界时受控 | artifact metadata 可查，下载或读取需要权限并记录 audit |
| SDK contract | 应用不用手写 protocol 细节 | client SDK 完成 create/connect/send/stream/reconnect happy path |

当前仓库仍是文档优先状态，还没有 verified build/test/lint/run command。实现阶段出现代码后，应把实际验证命令写回 [AGENTS.md](AGENTS.md)。

## 18. 架构会议需要做出的决定

这份 spec 建议会议先做下面几类决定，而不是立即进入目录结构或语言选择：

1. **首个验证 agent 场景**：是否以 coding/developer-tool agent 作为 V1 vertical slice？如果不是，哪个场景同样具备 long-running、workspace-heavy、human-in-the-loop、auth/audit 需求？
2. **Session lifecycle 和 recovery mode**：哪些状态进入 V1 contract？true continuation、restart with context、non-recoverable failure 如何暴露给用户和 SDK？
3. **Agent type compatibility**：什么条件下 worker 可以接手 session？config version、tool surface、workspace format、adapter capability 是否都必须参与判断？
4. **Storage consistency boundary**：event log、session catalog、workspace snapshot、artifact metadata 如何保持可恢复一致？失败时 session 进入什么状态？
5. **Authorization model**：tenant、principal、role/capability、resource/action 的最小模型是否足够？application-provided hook 在 V1 是否必须？
6. **Routing semantics**：central service 到 sidecar 的 delivery 是 at-least-once、ordered per session，还是需要更强语义？重复消息和 worker split brain 如何处理？
7. **Public API boundary**：client、backend、sidecar 三类 API 的稳定字段是什么？哪些 diagnostic 不进入 contract？
8. **V1 non-goals**：provider proxy、CMDB、mesh、通用环境 RPC、managed service、semantic context schema 是否都明确后置？

这些决定一旦达成，后续 implementation planning 才能拆成小而可审查的 slice：先 contract，再 single-instance vertical slice，再 persistence/recovery，再 auth/audit，再 production cluster。

## 19. 建议的第一批可交付物

第一批可交付物不是完整产品，而是一组能让架构和实现对齐的 artifacts：

1. Runtime object model spec：session、agent type、worker、event、snapshot、artifact、audit record 的字段、状态机和 ownership。
2. V1 API sketch：backend create/manage session、client connect/stream/replay、sidecar register/heartbeat/receive/submit snapshot。
3. Event model draft：最小 event envelope、核心 event type、ordering、idempotency、cursor replay 和 snapshot marker。
4. Recovery contract：agent type capability、true continuation/restart with context/non-recoverable 的判定和用户可见状态。
5. Authorization/audit draft：action matrix、hook contract、enforcement points、audit record shape。
6. Vertical slice prototype：single-instance central service + one process-wrapper sidecar + local persistent store + one client path。
7. Conformance test plan：只通过公共 API 验证 session lifecycle、routing、reconnect、event replay、worker death、snapshot restore、authorization failure 和 artifact access。

如果这些交付物能被架构会议接受，后续实现就可以按 vertical slice 分阶段推进，而不是先在目录结构或框架选择上消耗太多讨论。

## 20. 总结

Agent Runtime Sidecar 的产品机会不是“再做一个 agent platform”，而是把 agent 从 prototype 进入 production 时反复缺失的 runtime 层做成稳定边界。这个边界的中心是 session：它有 durable identity、event history、workspace state、access policy、audit trail 和 recovery semantics。Worker、sidecar、storage、SDK 和 deployment 都围绕这个中心展开。

因此，实施上要先做最小但完整的 runtime mainline：已有 agent 通过 sidecar 接入，同质化 worker pool 服务 session，central service 负责 routing 和 reconnect，storage 保存 event 和 workspace，authorization 和 audit 进入关键路径。只有这条主线成立，后续的 protocol adapter、heterogeneous environment、managed service、admin UI 和 semantic context 才有稳定地基。
