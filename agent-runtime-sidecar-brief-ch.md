# Agent Runtime Sidecar：把 Agent Session 当成可运营对象

## 1. 基本判断

我们对 AI agent 的一个基本判断是：它会从终端用户直接使用的工具，逐步进入应用和服务的调用链。早期的典型形态是用户在 IDE、CLI 或聊天窗口里直接启动 agent，让它写代码、改仓库、跑命令。接下来，越来越多 agent 会被 agentic application 调用。调用方会扩展到业务代码、app server 和 workflow backend，agent 也会成为产品流程里一种可组合、可编排、会持续产生状态的能力。

调用方变化以后，运行模型也会变化。App server 本来就大量依赖 cloud service：auth、storage、database、queue、notification、observability 都通过服务化组件获得。Agent 调用也会沿着同样路径，从本地拉起一个 process，逐步走向由单独 cloud service 提供运行能力。

这种 cloud service 天然不同于本地启动 agent。本地 agent 可以借用当前机器的文件系统、进程生命周期和用户交互；作为被 app server 调用的稳定服务，云上的 agent runtime 要面对多租户、断线重连、worker 重启、横向扩缩容、workspace persistence、权限控制和审计。对 application 来说，它需要的是一个稳定可调用的服务；对用户来说，一个 agent session 仍然应该像一段连续的工作：可以等待、可以恢复、可以接着交流，也可以追溯它做过什么。

因此，这个产品机会可以概括为一句话：

> 把 stateful、interactive agent 运行成 durable online service。

这里的关键抽象是 session。Session 需要独立于某个具体 worker 存在，能够持久化、恢复、路由、授权和审计。

## 2. 现实问题

今天很多团队在把 agent 放到云上时，会重复遇到同一组基础设施问题。

Agent 通常会运行很久。它可能连续处理代码库、数据集、notebook、工单或企业流程，中间不断产生文件、日志、tool result、approval request 和临时结论。一次 HTTP request 很难覆盖这种工作方式。

Agent 也需要实时交互。用户可能在运行过程中补充信息、批准操作、取消任务，或者要求 agent 改方向。Client 断线以后再回来，也应该能重新接到同一个 session，而不用知道当时是哪台机器在跑这个 agent。

Agent 还依赖 workspace。对 coding agent 和 data agent 来说，workspace 几乎就是它的工作现场。Cloud platform 可以很好地调度 container，却不会自然地替 agent 保存和恢复这个工作现场。

Agent session 也需要可观察和可审计。团队需要知道一个长任务运行到哪一步、产生了哪些 event、是否在等待 approval、失败在哪里、哪些用户或 service 访问过 session、workspace 或 artifact。传统日志和 metrics 有用，但它们通常不会自然形成 session-level view。

这些问题最后会落到 application team 身上。他们要自己写 session router、worker registry、WebSocket gateway、event log、workspace snapshot、permission check 和 client SDK。每个团队做出来的东西都相似，又都带着业务项目的临时痕迹。

## 3. 现有组件各自解决了一部分

Cloud hosting platform 负责运行 container、扩缩容和健康检查。Agent framework 负责 agent loop、model call 和 tool orchestration。Database、object store 和 message broker 负责持久化与消息传递。WebSocket 或 SSE 可以把输出流回 client。

这些能力都需要保留，也都很成熟。缺口出现在它们之间：谁以 session 为中心，把 worker、workspace、event stream、reconnect、authorization、observability、audit 和 recovery 组织成一个稳定的 runtime？

如果没有这个 runtime，每个在线 agent 产品都要在业务逻辑旁边再搭一套运行层。早期可以靠工程经验硬撑，到了 multi-tenant、long-running、public-facing 场景，复杂度会迅速变成产品风险。

## 4. Agent 运行时真正需要承接的对象

在进入产品形态前，需要先把 agent runtime 里真正需要被承接的对象拆清楚。一个可运行 agent 通常由几类东西共同组成。

第一类是 prompt 和 system prompt。它们定义 agent 的角色、任务边界、输出风格、工具使用方式和安全约束。对应用调用场景来说，这些内容会逐渐产品化：有些来自 agent type 的默认配置，有些来自 tenant 或项目配置，有些来自本次 session 的用户输入。

第二类是 tools 和 MCP server。Coding agent 需要读写文件、跑命令、查 repo、访问 issue 或 PR；企业 agent 可能需要调用内部系统、数据库、工单和审批流。MCP 让这些工具以较统一的方式接入 agent，但工具本身还涉及权限、凭据、网络位置、租户边界和审计。

第三类是 skills、instructions 和 memory。Claude Code 的 CLAUDE.md、auto memory、skills，Copilot 的 custom instructions、custom agents、MCP 配置，本质上都在告诉 agent：这个项目怎么工作、这个团队有什么习惯、某类任务应该怎么做。这些内容会影响每一次 session 的启动上下文，也会影响 agent 是否能稳定复现同一种工作方式。

第四类是 session 和 history。现有产品已经在保存 prompt、response、tool call、file change、checkpoint 或 task log。恢复 session 时，runtime 会把这些历史重新组织进模型输入，或者用它们恢复一个工作现场。对 cloud service 来说，session 还需要有自己的 identity、status、owner、participant、access policy 和 lifecycle。

第五类是 workspace 和 execution environment。Agent 的状态经常落在文件、branch、worktree、artifact、log 和临时目录里。对于 coding agent，这些东西比 conversation transcript 更接近真实工作结果。云上 runtime 需要知道什么时候创建 workspace、什么时候 snapshot、什么时候清理，以及 worker 失败后如何恢复。

这些对象决定了产品边界。Runtime 一端要贴近 agent process，接住 prompt context、workspace、tools/MCP/skills 和运行事件；另一端要面向 application server 和 client，提供稳定的 session identity、history、routing、authorization、audit 和 connection。这样 application server 才能把 agent 当作一个稳定服务调用，不必亲自理解每个 agent 产品内部的 session 机制。

## 5. 两类客户场景

这里需要把两类客户场景分开看。它们都会遇到 session、workspace、communication 和 audit 问题，但客户真正关心的价值不同，runtime 能控制的范围也不同。

| 维度 | 同质化 worker pool | 用户或任务自带环境 |
| --- | --- | --- |
| 环境假设 | 同一类 agent 的多个 worker 彼此接近，可以服务同一种 session | Agent 运行在用户、repo、CI、企业内网、开发机或边缘设备提供的环境里 |
| 客户真正要解决的事 | 把 agent 当成可扩展的在线服务运营起来：请求能路由，session 能持久化，worker 故障后能跨机器恢复 | 把分散环境里的 agent 变成可连接、可观察、可治理的服务端点：用户能回来继续看进展，平台能记录事件、权限和结果 |
| Runtime 的控制力 | 可以管理 worker、workspace、capacity 和 session lifecycle，因此大部分 session runtime 能力都能做深 | 很难假设 worker 可互换，也很难直接接管环境生命周期；更有意义的是稳定连接、事件流、身份信任、权限边界和审计 |
| 产品策略 | 适合作为 V1 主线，验证 durable session runtime 的核心价值 | 适合作为后续扩展，通过 connector、adapter 和 capability-based routing 支持 |

这个区分很重要。同质化 worker pool 里，跨机器恢复、容量调度、workspace 生命周期和 session routing 都是核心价值。用户或任务自带环境里，客户更在意 agent 是否能安全接入平台、长任务是否可见、断线后是否能继续跟踪、结果和操作是否可审计。后一类场景的产品形态会更接近跨环境的 session control plane。

## 6. 初始服务对象

基于上面的区分，V1 应该优先服务正在把同一类 agent 做成 online application 的团队。最典型的是 coding/developer-tool agent、data/analytics agent 和 enterprise workflow agent：它们都有长时间运行、workspace、tool event、用户中途参与、权限和审计需求，也更容易从同质化 worker pool 开始。

这意味着设计上要优先满足可运营的 cloud runtime：session 能独立存在，worker 能注册和被选择，workspace 能保存和恢复，client 能稳定连接和重连，权限检查能进入 routing path。只要这个主线成立，后续才有基础支持更多异构环境。

早期不应该把重心放在简单 chatbot、stateless API wrapper、已经完全依赖 managed agent platform 的客户，或高度分散的 personal device / edge device network。它们也可能需要 agent connection 和 event visibility，但不会首先验证 durable session runtime 的核心价值。

## 7. 核心设计原则

第一，session 是一等对象。Session 不能只存在于某个 worker 的内存里。它应该有自己的 identity、metadata、event history、workspace state、lifecycle status 和 access policy。

第二，恢复能力先建立在 workspace snapshot 和 event log 上。统一的 semantic context format 很有吸引力，但它会过早触碰不同 agent framework 的内部状态。早期更实际的路径，是保存用户可见事件和工作目录，再让 adapter 根据 agent 能力决定如何恢复或重启。

第三，sidecar 要优先适配已有 agent。最有价值的切入点很可能是 process wrapper：sidecar 启动并监督一个 CLI 或本地 process，把它接入 session runtime。这样团队可以先把已经可用的 agent 带到 cloud service，而无需重写 agent loop。

第四，初始场景应面向同质化 worker pool。这种场景更接近多数在线 agent application 的早期部署方式，也更容易验证 routing、scaling 和 recovery。

第五，central service 需要内建 authentication、authorization、tenant isolation 和 audit。它经常会成为 public-facing endpoint，权限检查必须发生在 session 创建、连接、消息路由、event replay、artifact access 和 worker registration 这些关键路径上。

## 8. 提议的产品形态

基于上面的 priority，产品应先聚焦在一个清晰的 runtime layer：

> Agent runtime sidecar + centralized session routing and communication service。

它可以拆成四个 component。与其展开职责清单，更适合先看每个 component 承接哪一类运行压力。

| Component | 承接的问题 | 核心职责 |
| --- | --- | --- |
| Central session service | Client 和 agent worker 之间需要一个稳定入口 | 管理 session、worker、routing、connection、authorization 和 audit |
| Agent runtime sidecar | 现有 agent process 需要被接入 cloud runtime | 准备运行环境，连接 agent process，转发事件，保存状态 |
| Persistent storage | Session、workspace 和事件不能只留在本机 | 保存 session catalog、event log、workspace snapshot、artifact 和 audit record |
| SDK 和 API | App、client、sidecar 需要用稳定方式接入 runtime | 提供创建 session、连接 session、发送事件、接收流、注册 worker 的接口 |

Central session service 是这个 runtime 的控制面和通信入口。Client 和 application backend 不需要知道某个 agent worker 在哪里，只需要面向 session 说话。它维护 session catalog、worker registry 和 connection state；当消息进入系统时，它决定这个消息属于哪个 session、应该送到哪个 worker、当前 principal 是否有权限，以及哪些事件需要进入 audit log。

Agent runtime sidecar 贴近 agent process。它的价值在于让已有 agent 更容易进入云上运行环境，而不要求团队重写 agent loop。Sidecar 可以作为 process wrapper 启动一个 CLI agent，也可以通过 SDK、local HTTP、gRPC、stdio、named pipe 或 socket 与 agent 通信。它负责准备 prompt context、workspace、tool/MCP/skills 配置，把 central service 的事件交给 agent，再把 agent output、tool event、状态变化和 checkpoint 写回 runtime。

Persistent storage 是 session continuity 的基础。它不需要一开始就定义复杂的统一 context schema，但至少要保存 session metadata、event history、workspace snapshot、artifact 和 audit record。这样 worker 重启、client 断线或 session 暂停以后，系统仍然有足够材料恢复工作现场，或向用户解释当前状态。

SDK 和 API 让这个 runtime 可以被产品真正使用。Client SDK 处理连接、输入、流式输出、approval、cancel 和 reconnect。Backend API 让 application server 代表用户创建或管理 session。Sidecar API 让 worker 注册能力、接收 routed event、上报状态并提交 snapshot。它们共同把底层 routing、streaming 和 recovery 细节收进 runtime 边界里。

一个简化的结构如下：

```text
Client / App Backend
        |
        | HTTPS / WebSocket / SSE
        v
Central Session Service
        |
        | Agent channel / event stream
        v
Agent Runtime Sidecar
        |
        | Process / SDK / local IPC
        v
Agent Process / Agent Harness

Persistent Storage:
- Session catalog
- Worker registry
- Event log
- Workspace snapshots
- Artifacts
- Audit records
```

这个结构的好处在于，client 看到的是稳定的 session endpoint，agent process 看到的是接近本地运行的工作环境，中间的 runtime 负责把两边连接起来。

## 9. 典型运行过程

新 session 开始时，client 或 application backend 向 central service 发起请求。Central service 完成身份校验，创建 session record，然后选择可用 worker。Sidecar 准备 workspace，启动或连接 agent process。之后用户输入、agent 输出、状态变化和 approval 都以 event 的形式经过 central service。

Client 断线后，session 仍然留在 catalog 和 event log 里。用户回来时，只需要用 session ID 重连。Central service 判断权限，恢复最近事件，必要时重新 attach 到 active worker。

如果 worker 失败，central service 可以把 session 标记为 recoverable，再选择 compatible worker。新的 sidecar 拉取最新 workspace snapshot 和 event context，让 agent 按它支持的方式继续工作。对于用户来说，这应该表现为一次可解释的恢复，任务不会凭空消失。

## 10. 初始产品范围

V1 要回答一个很具体的问题：客户能不能把一个已有 agent 接入 runtime，让它以 durable、interactive、multi-tenant online service 的方式跑起来。围绕这条链路，功能优先级可以分成四层。

1. **Agent 接入**
   这一层的核心目标是让客户用最小改造接入已有 agent。V1 的关键功能是 process-wrapper sidecar，它运行在 agent worker 旁边，把已有 agent process 接入 runtime。

   这一层最重要，因为它决定客户能不能复用现有 agent investment，降低试用 runtime 的改造成本。

   需要包含的能力：
   - **Process-wrapper sidecar**：启动或连接已有 CLI、本地 process 或 framework-based agent。
   - **Runtime event adapter**：把 central service 发来的 session event 转给 agent，再把 agent output、tool event 和状态变化写回 central service。
   - **Workspace preparation**：在 agent 启动前准备工作目录、基础配置和必要的上下文文件。

2. **Session runtime**
   这一层由 central session service 承担，目标是让 session 成为可管理的服务对象，避免只停留在某个 worker 的内存里。它负责知道有哪些 worker、哪些 session 正在运行，以及每条消息应该去哪里。

   需要包含的能力：
   - **Agent type**：一类兼容的 agent worker，例如同一种 coding agent image 和工具配置。
   - **Worker registration**：worker 向 central service 声明自己能服务哪类 agent。
   - **Heartbeat**：worker 定期报告自己仍然存活。
   - **Capacity tracking**：记录 worker 当前还能接多少 session 或任务。
   - **Durable session catalog**：保存 session ID、owner、status、active worker、history pointer 和 lifecycle。
   - **Session-aware routing**：根据 session 状态把新消息送到 active worker，或在需要时恢复到 compatible worker。
   - **Streaming / bidirectional communication**：client 持续接收 agent 输出，也可以发送输入、approval、cancel 或 correction。

3. **恢复和持久化**
   这一层保存 session 继续运行所需的证据和工作现场。早期目标是让 worker restart、client disconnect 或 session pause 之后，系统仍然有足够材料恢复工作现场，或给出清晰的状态解释。

   需要包含的能力：
   - **Event log**：记录用户输入、agent 输出、tool call、tool result、approval、error 和 lifecycle event。
   - **Workspace snapshot**：保存 agent 工作目录里的文件、artifact、log 和中间产物。
   - **Artifact persistence**：保存用户或系统需要保留、下载、审计或继续处理的输出。
   - **Runtime metadata**：记录恢复时需要的 agent type、worker capability、配置版本、checkpoint 时间和状态说明。

   完整的统一 context schema 可以留到需求被验证之后再推进。

4. **产品化接入和治理**
   这一层让 runtime 能被真实应用安全使用。它面向 client、application backend 和 sidecar 暴露稳定接口，同时把权限、租户边界和审计放进关键路径。

   需要包含的能力：
   - **Client SDK/API**：让 browser、desktop、CLI 或 backend client 创建 session、连接 session、发送输入、接收流式输出和重连。
   - **Backend SDK/API**：让 application server 代表用户创建 session、查询状态、管理访问策略。
   - **Sidecar SDK/API**：让 worker 注册能力、接收 routed event、上报状态和提交 snapshot。
   - **Authentication**：确认连接者是谁。
   - **Authorization**：判断它能对哪个 agent、session、workspace 或 artifact 做什么。
   - **Tenant isolation**：确保不同客户或组织的数据和 worker 边界清晰。
   - **Audit log**：记录 session creation、connection、message routing、approval、artifact access 和 authorization failure 等关键事件。

V1 可以先收窄这些内容：

1. 不做 model provider。
2. 不做完整 agent framework 或 agent builder。
3. 不做 full management UI、marketplace 或 application builder。
4. 不急于定义统一 context schema。
5. 不把异构或边缘设备 agent routing 放进第一阶段，例如同时调度本地开发机、企业内网机器、边缘设备和不同工具链的 agent。
6. 不把 managed cloud service 作为第一交付形态。

这个范围足够小，也足够有辨识度。它先跑通一条产品主线：已有 agent 通过 sidecar 接入，session 由 central service 管理，workspace 和 event 能恢复，client 可以稳定交互，企业客户需要的权限和审计有基本闭环。其他 agent platform 能力应围绕这条主线逐步增加。

## 11. 交付与部署路径

这个 runtime 的第一种交付形态应是 self-hostable software。早期客户需要在自己的 cloud、开发环境或受控网络里验证 agent session runtime，因此产品不应一开始就要求客户使用 managed service。

部署路径可以分三步。第一步是 single-instance development mode，用于本地开发、demo 和早期评估：一个 central service instance，local 或 embedded metadata storage，local workspace storage，以及一个或多个 sidecar worker。这个模式的价值是让团队快速验证已有 agent 能否通过 sidecar 接入 session runtime。

第二步是 production cluster mode。进入生产后，central service 需要多实例运行在 load balancer 后面，并使用 shared session catalog、shared event log 或 broker、shared workspace storage，以及 worker registry 和 heartbeat。这个阶段必须引入 tenant-aware authentication、authorization 和 audit。

第三步才是 managed cloud service。如果 self-hosted adoption 证明客户确实需要这个 runtime，但不愿长期运维 control plane，可以再提供 managed cloud-native service。Managed service 应复用同一套 session/runtime model，保持产品边界稳定。

## 12. 差异化

这个产品的差异化来自 operational runtime，而非 agent intelligence 本身。

它可以帮助团队把已有 CLI agent、本地 agent 或 framework-based agent 带到云上，保留原有 agent investment。它对 model provider、agent framework 和 cloud platform 保持中立，因此更容易进入已有技术栈。

相较于 AX 这类 distributed agent executor，本产品的重心更靠近 application-facing durable session runtime：通过 sidecar 适配已有 agent，并聚焦 client/session routing、workspace recovery、tenant-aware auth/audit 和服务化交付。

它把 durable workspace、session recovery、real-time interaction、approval flow、authorization 和 audit 放在同一个 session runtime 里。这些能力单独看都能用现有基础设施拼出来，组合在一起才是在线 agent 产品反复需要的运行边界。

这也让产品避开了最拥挤的 model orchestration 竞争区。它服务的是 agent 从 prototype 进入 production 时暴露出来的运行问题。

## 13. 需要验证的问题

第一，目标客户是否愿意引入一个独立 runtime layer，减少在业务系统里自建运行层。这个问题决定产品包装、部署方式和 SDK 设计。

第二，session recovery 到底能做到什么程度。这会是最难的验证点：workspace snapshot 加 event log 可以保存用户可见历史和工作现场，但不一定覆盖 agent 内部状态、tool state、未完成 tool call、临时 memory 或模型上下文压缩后的语义。MVP 需要明确哪些恢复是真正 continuation，哪些只是 restart with context；也需要定义 agent adapter 必须提供什么能力，runtime 才能安全地把 session 恢复到另一个 worker 上。

第三，协议策略要保持克制。可以先定义一个小的内部 event model，同时关注 AG-UI、A2A、MCP、ACP 等已有协议。Protocol compatibility 可以作为 adoption accelerator，但早期价值仍应落在 durable session runtime 上。

第四，authorization model 需要足够明确，又不能变成另一个 enterprise policy engine。比较实际的起点是 tenant、principal、agent type、session、role/capability，再提供 application-provided authorization hook。

第五，同质化 worker pool 是否能覆盖最早的高价值场景。Coding agent、data agent 和 enterprise workflow agent 都有机会，但第一个验证场景应该尽量集中。

## 14. 建议下一步

建议先做 self-hosted MVP，选择一个 workspace-heavy、long-running、需要用户实时参与的 agent 场景作为验证对象。Coding/developer-tool agent 是很自然的起点，因为它同时具备文件、命令、日志、approval、reconnect 和恢复需求。

MVP 的判断标准可以很简单：一个已有 agent 能否通过 sidecar 接入；用户能否创建 session、断线重连、持续接收输出；worker 失败后能否恢复 workspace 并给出清晰状态；业务系统能否在 session 和 artifact 级别做权限控制。

如果这条路径跑通，后续再扩展更复杂的 protocol adapter、管理 UI、managed service、异构 routing 和更强的 context portability。先把 durable session runtime 这件事做扎实，产品边界会自然清楚起来。