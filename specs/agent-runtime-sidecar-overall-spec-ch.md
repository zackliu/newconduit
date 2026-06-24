# Agent Runtime Sidecar Overall Spec：从可运行切片到生产化 Runtime

状态：架构讨论稿  
日期：2026-06-22  
读者：架构师、runtime owner、SDK/API owner、平台工程 owner

## 1. 文档目的

这份 spec 的目标不是重新列一遍 component 名字，而是回答架构讨论里一定会出现的三个问题：

1. **这到底是什么？** 这是一个把 stateful、interactive agent session 运行成 durable online service 的 runtime layer。它不替代 agent framework、model provider 或 cloud hosting platform，而是在这些系统之间提供 session identity、routing、reconnect、workspace persistence、recovery、authorization 和 audit。
2. **为什么需要它？** 当 agent 从本地 CLI、IDE、聊天窗口进入 application backend 和 online service 调用链以后，session 不能再只存在于某个 worker process 的内存里。应用需要一个稳定服务入口，用户需要一段可恢复、可追溯的连续工作，平台需要权限、租户边界和审计。
3. **每个部分先做什么，后做什么？** V1 要先验证一个已有 agent 能通过 sidecar daemon 接入同质化 worker capacity，并以 durable、interactive、self-hostable service 的方式运行。之后再扩展 cluster、异构环境、protocol adapter、managed service 和更强的 context portability。

本文以 [agent-runtime-sidecar-brief-ch.md](../agent-runtime-sidecar-brief-ch.md) 和 [agent-runtime-sidecar-brief-en.md](../agent-runtime-sidecar-brief-en.md) 作为当前产品边界。旧项目 `C:\Users\chenyl\conduit` 是重要设计输入，但不是实现基线，也不是迁移兼容目标。

`specs/` 目录后续按 resource model、controller、adapter、API 和 deployment 拆分。目录组织原则见 [README.md](README.md)，核心资源模型见 [runtime-resource-model-ch.md](runtime-resource-model-ch.md)。本文只保留 overall narrative 和架构会议需要讨论的主线。

## 2. 核心判断

Agent Runtime Sidecar 的核心判断是：**session 是 durable identity，worker 是被纳入 runtime 的 replaceable compute resource**。

这句话决定了整个系统的先后顺序。我们不能先做一个很聪明的 worker scheduler，再把 session persistence 补进去；也不能先做复杂 agent protocol，再让 application team 自己承担 session catalog 和 authorization。正确的起点是先把 session 定义成可运营对象，再让 Agent/AgentSpec、Worker、Event、Workspace state、SDK 和治理能力围绕它工作。

这里的 Worker 不是 class，也不等同于一个进程。它是 central service 视角里的 runtime resource：某个 container、VM、本地进程环境或 remote runner 中运行了 sidecar，sidecar 向 central service 注册并通过认证、声明能力、维持 heartbeat 之后，这个 computing resource 才成为一个 Worker。换句话说，sidecar 是具体跑着的 daemon/adapter；Worker 是这个 daemon 把底层 compute 纳入系统后形成的可调度资源身份。

一个 session 至少要回答这些问题：

- 它属于哪个 tenant、owner、principal 或 application？
- 它引用哪个 AgentSpec？这个 spec 是否仍然可用于调度和恢复？
- 它处于 created、running、awaiting input、recovering、failed、completed、deleted 等哪个 lifecycle state？
- 它当前由哪个 worker 服务？如果 worker 消失，哪些 worker 可以接手？
- 它的用户可见事件、workspace state、snapshot 和 audit record 存在哪里？
- 哪些主体可以创建、连接、发送消息、replay event、访问 workspace output、注册 worker 或触发 recovery？
- 它的恢复是 true continuation、restart with context，还是明确不可恢复？

如果这些问题没有先被建模，后续 component 再完整也会变成一组分散工具。架构上最重要的不是某个 registered Worker、storage 或 SDK 单独存在，而是它们共同服务于 session continuity 和 session governance。

## 3. 与旧 Conduit 的关系

旧 Conduit 已经验证过一些非常有价值的设计事实：session 和 compute 可以分离，client 可以通过 SDK 消费 session lifecycle 和 event stream，event log 可以成为恢复和 replay 的基础，conformance test 可以把 wire contract 固定下来。这些经验应该继承。

但新产品不能把旧 Conduit 直接搬过来。旧 Conduit 的重心更接近 host-centric control plane：本机 host 管 session、provider、tokens、profiles、workspace、tunnel、session process 和环境 RPC。Agent Runtime Sidecar 的重心更靠近 application-facing durable session runtime：central session service 是公开服务入口，sidecar daemon 把底层 compute 注册成 Worker，Worker 承接被调度的 session work，storage 保存 session/workspace/event/audit，权限检查进入 routing path。

| 旧 Conduit 经验 | 可以继承什么 | 需要调整什么 | V1 不应继承什么 |
| --- | --- | --- | --- |
| Host 管理 session lifecycle、event bus、diagnostics、workspace 和 compute | durable session 与 ephemeral compute 分离；snapshot 加 cursor stream 的客户端体验 | 从 host-centric 变成 central service-centric，client 默认面向 session service 而不是直接记住 compute endpoint | 本机 mesh、Dev Tunnels discovery、host-to-host federation 作为 V1 主线 |
| Session process 暴露 `fs.*`、`terminal.*`、`git.*`、`agent.*` 等 JSON-RPC service | session event log、checkpoint/restore、capability discovery、adapter composition | 新 compute resource 里的 sidecar daemon 应先包住已有 agent process，而不是要求 agent 变成完整 session platform | 把 V1 做成通用 remote IDE/runtime RPC 标准库 |
| Typed agent event vocabulary 和 schema versioning | canonical event、schema discipline、SDK 边界校验、conformance fixture | 先定义小而稳定的 runtime event model，再按需求扩大 agent semantic event | 过早标准化统一 semantic context schema |
| Client SDK 支持 snapshot 加 cursor stream、live list、reconnect | SDK 隐藏连接、replay、stream 细节，应用不用手写 gateway | 拆成 client SDK、backend API、worker/sidecar API 三类使用者 | 让 SDK 绕过 central authorization 直接和 worker 形成长期耦合 |
| CMDB、provider proxy、token、profile、runtime resource governance | 配置注入、secret 不暴露给 client、audit hook 这些思想有价值 | V1 只保留 agent runtime 所需配置和权限边界 | 把产品扩成 model provider gateway、enterprise CMDB 或 agent builder |
| Cloud prototype、Aspire、本地/云组合运行 | self-hostable development mode 和 production cluster mode 的交付路径 | 新设计应先明确 central state 和 registered workers，再考虑部署实现 | 假设旧 cloud API shape 就是新服务 contract |

旧 Conduit 给我们的最大提醒是：一旦产品同时承担 provider、CMDB、remote desktop、mesh、session runtime 和 agent adapter，边界会迅速变宽。新设计要把 runtime 问题先做深，而不是把所有相邻平台能力都吸进 V1。

## 4. 产品边界

V1 的一句话边界是：

> 让一个已有 agent 通过 sidecar daemon 接入同质化 worker capacity，并作为 durable、interactive、tenant-aware online session 被 application 调用。

这里的“已有 agent”可以是 CLI agent、本地 process、framework-based agent，或者已经能在 worker image 中启动的 agent harness。V1 不要求客户重写 agent loop，也不要求客户先采用新的 agent framework。

这里的“同质化 worker capacity”表示一组 registered workers 彼此兼容：它们能运行相同或可验证兼容的 AgentSpec，具备匹配的 tool surface、workspace preparation、runtime config 和 sidecar protocol。V1 先在这个假设下验证 routing、reconnect、recovery 和 auth/audit，因为这是最能证明 durable session runtime 价值的场景。

V1 明确不做：

- 不做 model provider，不负责训练、托管或选择模型。
- 不做完整 agent framework，不定义 agent loop 应该如何思考或调用工具。
- 不做通用 hosting platform，不替代 Kubernetes、container platform 或 VM scheduler。
- 不做 marketplace、full management UI 或 general application builder。
- 不急于定义跨所有 agent 的统一 semantic context format。
- 不把 personal device、edge device、企业内网机器和 cloud worker 的异构 routing 放进第一阶段。

这些 non-goal 不是说永远不做，而是说它们不能阻塞第一条产品主线：durable session runtime。

## 5. Durable Object Model

本节是资源模型摘要。完整定义、Kubernetes-style 类比、controller/watch 模式和可替换性边界见 [runtime-resource-model-ch.md](runtime-resource-model-ch.md)。

在讨论 component 之前，先要确定 runtime 里有哪些大类资源和事实。这里不应该列一堆过早的 object class，而应该像 Kubernetes 先区分 workload spec、node、pod/status/event 那样，先把几类概念的职责说清楚。

| 大类 | 是什么 | 为什么要有这个分类 | V1 先做到什么 | 后续再扩展什么 |
| --- | --- | --- | --- | --- |
| Agent / AgentSpec | Agent 是可运行能力，AgentSpec 是它的声明式定义 | 它回答“这种 agent 如何被创建、需要什么环境、能用什么工具、如何恢复”，让 session creation 和 worker matching 有共同依据 | AgentSpec ID、image/command 或 process 启动方式、tool/MCP/skills 约束、workspace contract、sidecar protocol、恢复能力声明 | spec version/digest、rollout、tenant-specific default、policy-aware spec |
| Session | 一次 durable agent work；central service 中的 session record 是它的 durable identity 和 source of truth | Session 把 owner、AgentSpec、lifecycle、current worker、event cursor、workspace state、access policy 绑在一起；worker 上运行的只是这个 session 的当前执行投影 | session ID、tenant/owner、AgentSpec reference 或 resolved copy、status、current worker lease/generation、event cursor、workspace snapshot pointer、access policy | session search、retention、handoff、cross-region metadata、advanced lifecycle analytics |
| Worker | 被 sidecar daemon 注册进 runtime、可用于运行 agent session 的 computing resource | 类似 Kubernetes Node：Node 是被 control plane 管理的 worker machine，可以是 VM 或物理机；Worker 也是被 central service 纳入系统的计算资源，可以是 container、VM、本地进程环境或 remote runner | worker registration、heartbeat、capacity/allocatable、labels/capabilities、conditions、supported AgentSpec constraints、current assigned sessions、drain state | placement policy、zone awareness、preemptible worker、hosting-specific adapters |
| Event | session 内发生的可 replay 事实 | reconnect、状态重建、audit 解释和 recovery 都依赖事件，而不是 transient log | append-only event log，覆盖 input、output、tool、approval、status、error、lifecycle、snapshot marker | schema registry、event compaction、semantic timeline、cross-session analytics |
| Workspace state and Snapshot | Workspace 是 agent 的工作现场；snapshot 是 workspace 在某个时间点的可恢复副本 | workspace state 是 coding/data agent 的主要工作结果和恢复材料。V1 先把输出留在 workspace 文件、event output 或 tool result 中，不单独引入新的输出资源边界 | workspace pointer、snapshot metadata、base event index、content location、access check | incremental snapshot、dedupe、retention policy、content scanning |
| Policy and Audit | Policy 决定谁能对 agent/session/worker/workspace output 做什么；audit 记录关键安全事实 | central service 是 public-facing endpoint，不能把权限只放在 application backend | tenant、principal、role/capability、resource/action、authorization hook、audit record | enterprise policy engine、SIEM export、retention controls、compliance report |

这个表有几个有意的取舍。

第一，AgentSpec 先作为 agent 的声明式定义出现。实现时可以给 AgentSpec 加 version 或 digest，但架构讨论阶段先不把版本管理展开成独立对象，以免抢走主线。

第二，Session 的 truth 在 central service 和 persistent storage：session record、event log、workspace state、snapshot metadata、policy/audit 才是 durable truth。Worker 上的 agent process、workspace mount 和 sidecar state 是当前运行投影，worker 死亡以后可以被重建或替换。

第三，Worker 采用 Kubernetes Node 的心智模型。Node 不是 workload 定义，它是被注册进 control plane 的计算资源，有 capacity、allocatable、conditions、addresses、labels 和运行时信息。这里的 Worker 也是这样：sidecar daemon 是实际跑着的本体，但 Worker 是 central service 里可调度、可观测、可授权的 resource identity。

第四，V1 不单独建模新的输出资源。所有输出先保留为 workspace 文件、event output 或 tool result。Snapshot 只回答“worker 失败后 workspace 能恢复到哪里”。如果未来确实需要把某些输出提升为可分享、可下载、可跨 session 引用的产品对象，再单独定义新的资源边界。

## 6. 目标架构

V1 的目标架构由四个主边界组成：central session service、registered Workers、persistent storage、SDK/API。Authorization、audit 和 observability 不是第五个“可选组件”，而是穿过这些边界的控制面能力。Sidecar 不和 Worker 并列；它是让底层 compute resource 接入 central service 并获得 Worker 身份的 daemon/adapter。

```text
Client / App Backend
        |
        | HTTPS / WebSocket / SSE
        v
Central Session Service
        |
        | Worker lease / routed event channel
        v
Compute Resource  (becomes Worker after sidecar registration)
        |
        +-- Sidecar daemon: registration, heartbeat, worker lease, workspace, events
        |
        +-- Agent Process / Agent Harness

Hosting Platform:
- Kubernetes / container platform / VMSS / local process manager
- Provisions compute for desired worker capacity
- Does not own session identity or recovery semantics

Persistent Storage:
- Session catalog
- Worker registry state
- Append-only event log
- Workspace snapshots
- Runtime metadata
- Audit records
```

Central session service 是应用和用户面对的稳定入口。它不应该把 worker endpoint 泄漏成 public contract。client 或 app backend 只需要持有 session ID，并通过 central service 创建、连接、发送输入、接收输出、replay history、访问 workspace output。Central service 在这些路径上做 authorization、routing、connection state、audit 和 session lifecycle transition。

Worker 是 runtime 眼里的可用 compute resource。它可以落在 Kubernetes pod、container、VM、本地进程或未来的 remote runner 上，但只有该 compute resource 内运行的 sidecar 向 central service 注册、维持 heartbeat 并接收 worker lease 后，它才成为 Worker。Sidecar 负责把 central service 的 session event 转成 agent 可理解的输入，把 agent output、tool event、permission request、status 和 checkpoint 写回 central service。

Hosting platform 是外部底座。它负责启动 pod/container/VM、资源限制、镜像、网络、volume 和底层扩缩容。Agent Runtime 不替代它；Agent Runtime 通过 worker registration 知道有多少 compatible worker capacity，并通过 capacity scaler 或 hosting adapter 把 session demand 转成 hosting platform 的 desired capacity。

Persistent storage 是 continuity 的基础。它要保存的是可以恢复和解释 session 的材料，而不是所有 agent 内部状态的完美镜像。V1 应该诚实承认：event log 加 workspace snapshot 可以恢复用户可见历史和工作现场，但并不自动等价于恢复模型内部上下文、未完成 tool call 或 agent 私有 memory。

SDK/API 是产品使用边界。Client SDK 让 UI 或 CLI 不必手写 reconnect 和 event replay。Backend API 让 application server 代表用户创建 session、管理 policy、查询状态。Worker/Sidecar API 由 sidecar 调用，用来把所在 compute resource 注册成 Worker、接收 routed event、上报状态、提交 snapshot。三类接口必须共享同一套 session model，但权限和职责不同。

这个分层借鉴 Kubernetes 的控制面模式，但 durable object 不是 pod，而是 Session。AgentSpec 类似 workload template，Worker 类似 Node，sidecar daemon 类似把底层计算资源接入控制面的 node agent。Central service 负责 reconcile Session，hosting platform 负责 provision compute。

## 7. 整体实施顺序

实施顺序应围绕一个 vertical slice 展开：先跑通一个已有 agent 的 durable session，再扩展可靠性、治理和规模。每个阶段都应该产生可讨论、可测试、可替换的 contract。

| 阶段 | 要回答的架构问题 | 先做什么 | 先不做什么 | 退出标准 |
| --- | --- | --- | --- | --- |
| Phase 0：契约和场景冻结 | V1 到底验证哪个客户场景？哪些大类资源和事实是 durable？ | 固定 coding/developer-tool agent 或另一个 workspace-heavy agent 作为首个场景；定义 AgentSpec、Session、Worker、Event、Workspace/Snapshot、Policy/Audit 的最小 schema；写清 non-goals | 不选多个垂直行业同时验证；不讨论 managed service 商业化 | 架构师能用同一套词解释 AgentSpec、session truth、worker as registered compute resource、sidecar daemon、hosting platform 和 recovery mode |
| Phase 1：单机 self-hosted vertical slice | 一个已有 agent 能不能以最小改造接入 runtime？ | 单 central service instance；一个本地 compute resource；compute 内 process-wrapper sidecar；AgentSpec；create session；worker registration；basic event stream；workspace preparation；manual cancel/stop | 不做 cluster scheduler；不做复杂 UI；不做异构 worker；不做 semantic context schema | 用户能创建 session、看到流式输出、中途输入或 approve、断开后按 event cursor 追上历史 |
| Phase 2：durable routing 和 reconnect | session 能不能独立于 worker endpoint 被访问？ | durable session catalog；worker heartbeat/capacity；current worker lease/generation 作为 session metadata；session-aware routing；client reconnect；event replay；basic idempotency | 不做多区域；不做复杂 placement policy；不让 client 直连 worker 成为 public contract | client 只持有 session ID；worker 重启或 client 断线不会让 session 从列表消失 |
| Phase 3：persistence 和 recovery honesty | worker 失败以后系统能恢复什么，不能恢复什么？ | append-only event log；workspace snapshot；runtime metadata；recoverable/failed state；true continuation 和 restart with context 的显式区分 | 不声称任意 agent 都能无损恢复；不做统一语义上下文标准 | worker failure 后，系统能选择 compatible worker，恢复 workspace，replay 必要事件，并向用户说明恢复模式 |
| Phase 4：authorization、tenant isolation 和 audit | 这个 runtime 能不能安全进入 application 调用链？ | tenant/principal/session role model；create/connect/route/replay/workspace output access/worker registration 的权限检查；audit record；application-provided authorization hook 的最小形态 | 不做完整 enterprise policy engine；不把权限只交给调用方 app server | 每条关键路径都有明确 allow/deny 结果和 audit trail；越权 route 和 workspace output access 被拒绝 |
| Phase 5：production self-hosted cluster | 单机模型能不能进入客户自有生产环境？ | shared session catalog；shared event log 或 broker；shared workspace storage；multi-instance central service；worker capacity scaler 与 hosting platform scaling；health/metrics/tracing | 不先做 managed cloud；不支持跨环境 edge routing | central service 可以水平扩展；workers 可以滚动重启；session metadata 和 event 不依赖单机磁盘 |
| Phase 6：扩展生态和高级能力 | 哪些能力在核心 runtime 被验证后值得加？ | protocol adapter、multi-language SDK、admin UI、semantic context experiments、heterogeneous connector、managed service | 不让扩展能力改变 V1 session/runtime model | 新能力作为 adapter 或部署形态加入，不重写 session identity 和 routing 语义 |

这个顺序的关键是：**先证明 runtime mainline，再扩大平台边界**。如果 Phase 1 到 Phase 3 没有跑通，后面的 protocol compatibility、UI、managed service 都会建立在不稳定的 session model 上。

## 8. Central Session Service：先定义 session control plane，再扩展调度

Central session service 是最容易被误解的部分。它不是普通 API gateway，也不是单纯 WebSocket server。它是 session control plane 和 communication entry point。

它先要做的事情是让 session 成为可寻址、可授权、可路由、可恢复的对象：

- 定义 session catalog：session ID、tenant、owner、AgentSpec reference 或 resolved copy、status、current worker lease/generation、event cursor、workspace pointer、createdAt、updatedAt、lifecycle reason。
- 定义 worker registry：worker ID、supported AgentSpec constraints、capabilities、heartbeat、capacity/allocatable、conditions、labels、current session count、drain state。
- 定义 worker capacity signal：某类 AgentSpec 的 pending sessions、available workers、desired capacity 和 hosting backend reference。
- 定义 routing decision：新消息进入后，central service 判断 principal 是否有权限、session 是否可接收输入、active worker 是否有效、是否需要进入 recovery。
- 定义 connection state：client attach/detach、sidecar attach/detach、stream cursor、backpressure 基本策略。
- 定义 lifecycle transition：created、queued、starting、running、awaiting input、recovering、failed、completed、deleted 等状态的合法迁移。

这些能力应该先于复杂 scheduler。架构师可能会问：“为什么不一开始就做 Kubernetes style scheduler？”答案是，V1 的风险不在于找不到一台机器，而在于系统是否能把一条 session 的身份、权限、事件和 workspace 与 worker 解耦。调度策略可以后置，routing contract 不能后置。

Central service 后续再做：

- 更复杂的 placement policy，例如 zone、cost、data locality、tenant quota。
- worker drain、rolling upgrade、AgentSpec canary。
- Worker capacity scaler，把 session backlog/capacity signal 转成 Kubernetes replicas、KEDA metric、VM scale set capacity 或其他 hosting platform desired state。
- 多实例 coordination、distributed lock 或 lease。
- session search、fleet-level dashboard、跨区域复制。

会议上需要重点讨论：current worker lease/generation 是强 lease 还是可抢占 lease；消息路由是否需要 exactly-once 语义，还是通过 event idempotency 提供 at-least-once 加去重；worker heartbeat 超时后如何避免两个 worker 同时写同一 session；worker capacity scaler 到 hosting platform 的接口是 declarative desired capacity 还是 imperative provisioning call。

## 9. Worker 和 Sidecar：先让 compute resource 进系统，再 richer adapter

Worker 是 central service 可调度的 compute resource identity，sidecar 是这个 resource 内部实际运行的 runtime daemon。Sidecar 不应该和 worker 并列，因为它不是一类可调度 capacity，也不是 durable object；它是让某个 pod/container/VM/local process 成为 Worker 的控制和适配层。

Sidecar 的存在是为了避免把客户挡在“必须重写 agent loop”之前。它应该先做 process-wrapper，而不是先设计一个理想的 agent SDK。

Process-wrapper sidecar 先要做到：

- 启动后向 central service register worker，声明 supported AgentSpec constraints、sidecar protocol version、capacity/allocatable 和 labels/capabilities。
- 维持 heartbeat、capacity report、conditions、drain state，并接收 worker lease 指令。
- 启动或 attach 到已有 agent process，管理 process lifecycle、exit code、stdout/stderr、stdin 或本地 API。
- 准备 workspace：创建目录、拉取或恢复 workspace snapshot、写入必要 runtime config、注入 session metadata。
- 把 central service 的 user input、approval、cancel、system event 转给 agent。
- 把 agent output、tool event、permission request、status、error、checkpoint signal 转成 runtime event。
- 定期上报 sidecar health、agent health、capacity 和 snapshot/checkpoint 状态。
- 在取消、超时或 worker drain 时，让 agent 有可解释的停止路径。

为什么先这样做？因为最早客户已经有 agent investment。产品价值不是让他们先学一个新 framework，而是把现有 agent 放进 durable session runtime。旧 Conduit 的 session SDK 证明了完整 session process 能力很强，但新设计的 wedge 应该更低：先让 sidecar daemon 把已有 agent process 包进一个可注册的 compute resource，再逐步变成 adapter SDK。

Sidecar 后续再做：

- local HTTP、gRPC、stdio、named pipe、socket 等多种 agent bridge。
- framework-specific adapter，例如 Copilot、Claude、LangGraph、AutoGen 或客户自研 harness。
- structured capability discovery、tool permission mediation、MCP server lifecycle。
- richer checkpoint protocol，例如 agent 主动声明可恢复点、压缩摘要、未完成 tool call 状态。

会议上需要重点讨论：Worker 的身份到底是 sidecar credential、pod identity、VM identity 还是它们的组合；process-wrapper 如何识别 structured event；如果只能读 stdout，哪些能力只能 best effort；sidecar 是否可以强制 agent 在每个 turn 后产生 checkpoint；当 agent 阻塞等待用户输入或 tool approval 时，central service 如何知道 session 是 awaiting input 而不是 hung。

## 10. Persistent Storage：先保存可解释恢复材料，再追求完整语义可移植

Storage 的第一职责不是成为万能 memory system，而是保存 session continuity 的证据和工作现场。

V1 先需要四类 storage contract：

1. **Session catalog**：服务于 list、connect、route、recover、delete。它需要事务性地记录 lifecycle state 和 current worker lease/generation。
2. **Event log**：append-only，带 event ID、session ID、type、schema version、actor、timestamp、causality/correlation ID、payload、visibility 或 audit marker。它支撑 replay、debug、reconnect 和部分恢复。
3. **Workspace snapshot storage**：保存文件、日志和中间产物。snapshot 需要标记它对应到哪个 event index 或 checkpoint boundary。
4. **Audit records**：保存安全关键路径上的访问和决策，不能只依赖普通 debug log。

V1 不需要先发明统一 semantic context schema。这个判断很重要。不同 agent framework 的内部上下文、memory、tool state、conversation compaction 都不同。把它们过早统一，会让 runtime 变成 agent framework 竞争区。更稳的路径是先保存 runtime 可观测事实和 workspace，再让 adapter 明确声明自己支持哪种 recovery。

后续可以扩展：

- incremental snapshot、content-addressed storage、large workspace retention。
- event schema registry 和 projection-time migration。
- session summary、semantic checkpoint、bounded model-visible context。

会议上需要重点讨论：event append 和 workspace snapshot 的一致性边界。比如 snapshot 成功但 event append 失败，或者 event 已提交但 snapshot 上传失败，session 应进入什么状态？这些不是实现细节，而是 recovery semantics 的一部分。

## 11. SDK/API：先固定三类使用者，再扩语言和 protocol

SDK/API 不能只服务 client UI。这个 runtime 至少有三类调用者：client、application backend、sidecar daemon。它们都围绕 session，但权限和职责不同。

Client SDK/API 先做：

- create 或 request session，具体是否允许由 backend 和 auth policy 决定。
- connect session，接收 snapshot 加 cursor stream。
- send user input、approval、cancel、correction。
- replay event、resume stream、查询 workspace output metadata。

Backend API 先做：

- 代表用户创建 session，绑定 tenant、owner、AgentSpec、initial workspace、initial policy。
- 查询 session state、列出用户可见 session、管理 access policy。
- 提供 authorization hook 或 policy decision integration。

Worker/Sidecar API 先做。这里真正调用 API 的是 sidecar daemon；API 产生或更新的是 Worker 这个 control-plane resource：

- worker registration、capability advertisement、heartbeat、capacity report、drain state。
- current worker lease 接收。
- routed event receive、runtime event append、status update、snapshot submit。
- graceful drain、shutdown、recover request。

这些 API 的顺序应该是 contract first。旧 Conduit 的 conformance suite 经验值得继承：wire-level contract、event shape、error code、cursor replay、lifecycle transition 都要有公共行为测试。新 repo 目前还没有代码和验证命令，所以 spec 阶段不要声称已有 build/test/lint 保障；等实现出现后，再把验证命令写回 repo 指令。

后续再做：

- TypeScript 之外的 C#、Python、Go SDK。
- AG-UI、A2A、MCP、ACP 等 protocol adapter。
- higher-level UI components、recorder、test harness。

会议上需要重点讨论：哪些字段属于 stable public contract，哪些只是 diagnostic；错误是否可机器处理；SDK 是否应该隐藏 routing/reconnect，但不能隐藏 authorization denial 和 recovery mode。

## 12. Authorization、Tenant Isolation 和 Audit：先放进关键路径，不后补

Authorization 不能等到 runtime 能跑以后再补。原因很简单：central session service 会成为 public-facing endpoint。如果创建 session、连接 session、发送消息、event replay、workspace output access 和 worker registration 一开始没有权限边界，后续再加会改变 API contract 和数据模型。

V1 先定义一个足够小的 authorization model：

- Tenant：数据和 registered worker capacity 的隔离边界。
- Principal：用户、service account、application backend、sidecar daemon。
- Resource：AgentSpec、worker registration、session、workspace snapshot、workspace output。
- Action：create、connect、send、approve、cancel、replay、read workspace output、register worker、recover、delete。
- Role/capability：把常见权限组合成可读规则。
- Application authorization hook：允许客户业务系统参与决策，但 central service 仍负责执行结果。

Audit 先覆盖安全关键路径：

- session creation、connection、disconnection。
- message routing、approval、cancel。
- event replay 和 workspace output access。
- worker registration、worker lease update、recovery。
- authorization failure 和 policy hook failure。

后续再扩展 enterprise policy engine、fine-grained tool policy、SIEM export、compliance report。V1 不需要成为通用企业策略平台，但必须让每条关键路径都有明确的 allow/deny 和 audit record。

会议上需要重点讨论：Worker 这个 resource identity 是否代表 tenant 内可信 compute；sidecar credential 如何和 hosting platform identity 绑定并轮换；worker registration 是否只能进入特定 tenant 或 capacity scope；application-provided hook 超时或失败时默认 deny 还是 fail open。对生产 runtime 来说，这些都是产品语义，不只是运维配置。

## 13. 关键运行流程

### 13.1 Create and Start Session

先实现的流程：application backend 或 client 请求创建 session。Central service 验证 principal，解析并记录 AgentSpec，创建 session record。然后 central service 根据 session metadata 中的 AgentSpec、policy 和 worker capacity 找到可用 Worker，并在 session metadata 中写入 current worker lease/generation。该 Worker 对应 compute resource 内的 sidecar daemon 接到 worker lease 后准备 workspace，启动 agent process，报告 ready。用户输入和 agent 输出都以 event 进入 central service。

后续扩展的流程：队列化启动、复杂 placement、quota、priority、pre-warmed worker、multi-tenant capacity reservation、worker desired capacity 更新。

架构讨论重点：session record 应在 worker ready 前创建，因为 session identity 不能依赖 worker 启动成功。worker 启动失败应成为 lifecycle event，而不是让 create request 悄悄消失。Session metadata 应记录 AgentSpec reference 或 resolved copy，避免恢复时依赖一个含义漂移的名字。

### 13.2 Client Reconnect

先实现的流程：client 使用 session ID 重新连接 central service。Central service 做 authorization，返回 session snapshot 和 event cursor，从 cursor 开始 replay 或 stream。client 不需要知道 active worker endpoint。

后续扩展的流程：多 client presence、collaboration role、cursor retention、offline notification、partial transcript projection。

架构讨论重点：event replay 是用户体验的一部分，不是 debug feature。cursor 过期时必须有明确行为：返回需要 fresh snapshot，而不是让 client 猜测状态。

### 13.3 Worker Failure and Recovery

先实现的流程：Worker heartbeat 超时、lease 过期，或 sidecar daemon 报告 failure 后，central service 将 session 标记为 recovering 或 failed。若 AgentSpec、workspace snapshot、event log 和 adapter capability 满足条件，则选择 compatible Worker，并更新 session metadata 里的 current worker lease/generation。新 Worker 对应 compute resource 内的 sidecar daemon 拉取 snapshot 和必要 event context，按 adapter 声明的模式恢复。

后续扩展的流程：自动重试策略、zone failover、incremental checkpoint、未完成 tool call repair、operator intervention UI。

架构讨论重点：不要把所有恢复都叫 resume。V1 应明确三种语义：

- **True continuation**：agent adapter 能恢复内部状态或足够精确的 checkpoint，用户可以认为同一 turn 连续进行。
- **Restart with context**：runtime 恢复 workspace 和 history，让 agent 重新进入任务，但不保证内部状态无损。
- **Non-recoverable failure**：缺少 snapshot、AgentSpec 不兼容、tool state 不可恢复，系统只能展示失败状态和已有 workspace output。

### 13.4 Approval and Human-in-the-loop

先实现的流程：agent process 通过 sidecar daemon 发出 permission request 或 user input request。Central service 持久化 request event，通知有权限的 client。client response 经过 authorization 后路由回 current worker lease 对应的 sidecar daemon。request completion 也写入 event log。

后续扩展的流程：approval delegation、timeout policy、multi-approver、tool-specific policy、location-scoped approval。

架构讨论重点：approval 不能只是 worker 内存里的 pending promise。否则 client 断线、worker failure 或 audit review 时都无法解释系统状态。

### 13.5 Workspace Output Access

先实现的流程：sidecar daemon 或 agent process 产生 workspace 文件、tool result 或 event output。Central service 不把它们提升成独立输出资源，只记录必要的 workspace output metadata 或 event reference。用户访问 workspace output 时经过 session/workspace authorization，并记录 audit。

后续扩展的流程：output promotion、sharing、retention policy、content scanning、lineage。

架构讨论重点：V1 不把 output 建模成独立资源。先确认 workspace output 的访问、审计和 retention 是否足够；如果不够，再定义独立 output resource。

## 14. Recovery Semantics

Recovery 是最容易被过度承诺的部分。V1 的目标不是保证所有 agent 在所有情况下无损恢复，而是保证 runtime 能保存足够材料，并诚实表达恢复等级。

V1 的恢复判断可以按顺序执行：

1. Session 是否存在，且状态允许 recovery？
2. 当前 principal 或 system actor 是否有 recover 权限？
3. 是否存在可用 workspace snapshot？它对应的 event index 是多少？
4. 是否存在 compatible worker？AgentSpec、required capability、sidecar protocol 和 workspace contract 是否匹配？
5. Adapter 是否声明支持 true continuation 或 restart with context？
6. 是否存在未完成 approval、tool call、file operation 或 external side effect？如果存在，如何向用户展示？

恢复成功后，系统应该写入 recovery event，说明 source worker、target worker、worker lease generation、snapshot ID、event index、recovery mode 和任何降级原因。恢复失败也应该是 session lifecycle 的可见状态，而不是普通 error log。

后续如果要做 semantic context portability，也应该作为恢复能力的增强项，而不是 V1 的先决条件。否则 runtime 会被迫理解每个 agent framework 的私有记忆、压缩策略和 prompt assembly。

## 15. Observability and Operations

V1 的 observability 先围绕 session 和 worker，而不是围绕 generic infrastructure metrics。

先做：

- session state timeline：created、assigned、started、input received、agent active、awaiting approval、snapshot created、recovering、completed、failed。
- worker capacity health：desired capacity、registered workers、available capacity、pending sessions、scaling signal。
- worker health：registered、heartbeat、capacity、assigned sessions、drain state、last failure。
- event ingestion health：append latency、stream cursor、replay failure、event retention。
- snapshot health：snapshot started、completed、failed、size、duration、base event index。
- authorization and audit health：allow/deny count、hook latency、audit write failure。

后续再做完整 admin UI、fleet dashboard、SLO、cost analytics、cross-session search。旧 Conduit 的 diagnostics 和 event bus 经验可以借鉴，但新 runtime 首先要形成 session-level view，让 application 和 operator 都能回答“这段 agent work 到哪一步了”。

## 16. Deployment Path

交付顺序应该是 self-hostable first。

第一步是 **single-instance development mode**：一个 central service instance，本地或嵌入式 metadata storage，本地 workspace storage，以及一个或多个运行 sidecar daemon 的本地 compute resource。Sidecar 注册成功后，这些 compute resource 成为 Worker。这个模式服务 demo、开发和早期客户验证，要尽量低摩擦，因为 V1 需要快速证明已有 agent 能接入。

第二步是 **production cluster mode**：central service 多实例部署在 load balancer 后面，共享 session catalog、event log 或 broker、workspace/object storage、worker registry、worker capacity state 和 audit storage。Worker capacity scaler 通过 Kubernetes Deployment/HPA/KEDA、container platform、VM scale set 或其他 hosting backend 调整实际 compute。这个阶段必须完成 tenant-aware auth、authorization、audit、health 和 backup/restore。

第三步才是 **managed service**：如果 self-hosted adoption 证明客户需要这个 runtime，但不想长期运维 control plane，再提供 managed cloud service。Managed service 应复用同一 session model，不应该变成另一个产品。

旧 Conduit 的本地 host 体验说明低摩擦启动很重要，但新产品的生产目标不是每台机器一个独立 host mesh，而是 central state 加 replaceable registered workers。Hosting platform provisions compute；sidecar daemon turns compute into registered Worker resource；central service assigns durable sessions to compatible workers。

## 17. Validation Matrix

这个 spec 的实现计划应该用业务行为和 public contract 来验证，而不是检查私有 helper 或源码结构。

| 验证项 | 应证明什么 | 最小验收方式 |
| --- | --- | --- |
| Existing agent integration | process-wrapper sidecar daemon 能把 compute 注册成 Worker 并接入已有 agent | 启动一个真实或 reference agent，创建 session，发送输入，收到流式 output |
| Durable session catalog | session 不依赖 worker 内存 | 停止 client 后重新列出和连接同一 session |
| Reconnect and replay | client 可以用 cursor 补齐历史 | 断开连接，产生新 event，重连后从上次 cursor replay |
| Routing boundary | client 不需要 worker endpoint | 只用 session ID 经 central service 发送消息 |
| Worker failure recovery | worker 可替换，恢复语义可解释 | 杀掉 worker 或让 lease 过期，选择 compatible worker，恢复 workspace，并写 recovery event |
| Authorization | critical path 有 allow/deny | 未授权 principal 无法 connect、send、replay 或 read workspace output |
| Audit | 安全关键动作可追溯 | create/connect/route/replay/workspace output access/worker registration 有 audit record |
| Workspace snapshot | 工作现场可恢复 | agent 修改 workspace 后 snapshot，恢复到新 worker 可看到文件状态 |
| SDK contract | 应用不用手写 protocol 细节 | client SDK 完成 create/connect/send/stream/reconnect happy path |

当前仓库仍是文档优先状态，还没有 verified build/test/lint/run command。实现阶段出现代码后，应把实际验证命令写回 [AGENTS.md](../AGENTS.md)。

## 18. 架构会议需要做出的决定

这份 spec 建议会议先做下面几类决定，而不是立即进入目录结构或语言选择：

1. **首个验证 agent 场景**：是否以 coding/developer-tool agent 作为 V1 vertical slice？如果不是，哪个场景同样具备 long-running、workspace-heavy、human-in-the-loop、auth/audit 需求？
2. **Session lifecycle 和 recovery mode**：哪些状态进入 V1 contract？true continuation、restart with context、non-recoverable failure 如何暴露给用户和 SDK？
3. **AgentSpec compatibility**：什么条件下 worker 可以接手 session？AgentSpec、tool surface、workspace format、sidecar protocol、adapter capability 是否都必须参与判断？
4. **Storage consistency boundary**：event log、session catalog、workspace snapshot、workspace output metadata 如何保持可恢复一致？失败时 session 进入什么状态？
5. **Authorization model**：tenant、principal、role/capability、resource/action 的最小模型是否足够？application-provided hook 在 V1 是否必须？
6. **Worker 与 hosting platform 边界**：capacity scaler 只写 desired capacity，还是直接调用 hosting API？Kubernetes、VMSS、本地进程管理器是否都通过 adapter 接入？
7. **Routing semantics**：central service 到 current worker lease 对应 sidecar 的 delivery 是 at-least-once、ordered per session，还是需要更强语义？重复消息和 worker split brain 如何处理？
8. **Public API boundary**：client、backend、worker/sidecar 三类 API 的稳定字段是什么？哪些字段描述 Worker resource，哪些字段只是 sidecar diagnostic？
9. **V1 non-goals**：provider proxy、CMDB、mesh、通用环境 RPC、managed service、semantic context schema 是否都明确后置？

这些决定一旦达成，后续 implementation planning 才能拆成小而可审查的 slice：先 contract，再 single-instance vertical slice，再 persistence/recovery，再 auth/audit，再 production cluster。

## 19. 建议的第一批可交付物

第一批可交付物不是完整产品，而是一组能让架构和实现对齐的材料：

1. Runtime resource model spec：Agent/AgentSpec、Session、Worker、Event、Workspace/Snapshot、Policy/Audit 的字段、状态和 ownership。
2. V1 API sketch：backend create/manage session、client connect/stream/replay、sidecar register/heartbeat/receive/submit snapshot 并更新 Worker resource。
3. Event model draft：最小 event envelope、核心 event type、ordering、idempotency、cursor replay 和 snapshot marker。
4. Recovery contract：AgentSpec capability、true continuation/restart with context/non-recoverable 的判定和用户可见状态。
5. Authorization/audit draft：action matrix、hook contract、enforcement points、audit record shape。
6. Vertical slice prototype：single-instance central service + one local compute resource running process-wrapper sidecar + local persistent store + one client path。
7. Conformance test plan：只通过公共 API 验证 session lifecycle、routing、reconnect、event replay、worker death、snapshot restore、authorization failure 和 workspace output access。

如果这些交付物能被架构会议接受，后续实现就可以按 vertical slice 分阶段推进，而不是先在目录结构或框架选择上消耗太多讨论。

## 20. 总结

Agent Runtime Sidecar 的产品机会不是“再做一个 agent platform”，而是把 agent 从 prototype 进入 production 时反复缺失的 runtime 层做成稳定边界。这个边界的中心是 session：它有 durable identity、AgentSpec、event history、workspace state、access policy、audit trail 和 recovery semantics。AgentSpec、Worker resource、sidecar daemon、Event、Workspace/Snapshot、storage、SDK 和 deployment 都围绕这个中心展开。

因此，实施上要先做最小但完整的 runtime mainline：已有 agent 通过 sidecar daemon 接入，同质化 registered worker capacity 服务 session，central service 负责 routing 和 reconnect，storage 保存 event 和 workspace，authorization 和 audit 进入关键路径。只有这条主线成立，后续的 protocol adapter、heterogeneous environment、managed service、admin UI 和 semantic context 才有稳定地基。
