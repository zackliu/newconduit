# Agent Runtime Sidecar: Treating Agent Sessions as Operable Objects

## 1. Core Assumption

Our core assumption about AI agents is that they will move from tools used directly by end users into the invocation path of applications and services. The early pattern is users launching agents directly in an IDE, CLI, or chat window to write code, modify repositories, or run commands. Next, more agents will be invoked by agentic applications. The caller will expand to business code, app servers, and workflow backends, and agents will become a composable, orchestratable capability inside product flows, continuously producing state as they work.

As the caller changes, the runtime model changes as well. App servers already rely heavily on cloud services: auth, storage, databases, queues, notifications, and observability are all provided through service components. Agent invocation will follow the same path, moving from starting a local process toward having a dedicated cloud service provide runtime capabilities.

This kind of cloud service is inherently different from starting an agent locally. A local agent can rely on the current machine's file system, process lifecycle, and user interaction. As a stable service invoked by an app server, a cloud agent runtime must handle multi-tenancy, reconnects, worker restarts, horizontal scaling, workspace persistence, permission control, and audit. For the application, it needs to be a stable callable service. For the user, an agent session should still feel like one continuous piece of work: it can wait, resume, continue the conversation, and provide a record of what happened.

The product opportunity can therefore be summarized in one sentence:

> Run stateful, interactive agents as durable online services.

The key abstraction is the session. A session needs to exist independently of any specific worker, and it needs persistence, recovery, routing, authorization, and audit.

## 2. The Practical Problem

Teams putting agents in the cloud repeatedly run into the same infrastructure problem.

Agents often run for a long time. They may continuously work through codebases, datasets, notebooks, tickets, or enterprise workflows, producing files, logs, tool results, approval requests, and interim conclusions along the way. A single HTTP request does not fit this style of work well.

Agents also need real-time interaction. Users may add information, approve actions, cancel tasks, or steer the agent in a new direction while it is running. If a client disconnects and returns later, it should be able to reconnect to the same session without knowing which machine was running the agent.

Agents also depend on workspaces. For coding agents and data agents, the workspace is almost the agent's worksite. Cloud platforms can schedule containers well, but they do not naturally save and restore this worksite for the agent.

Agent sessions also need observability and audit. Teams need to know how far a long-running task has progressed, which events it has produced, whether it is waiting for approval, where it failed, and which users or services accessed the session, workspace, or artifact. Traditional logs and metrics are useful, but they usually do not naturally form a session-level view.

These problems eventually fall on the application team. They end up building their own session router, worker registry, WebSocket gateway, event log, workspace snapshot mechanism, permission checks, and client SDK. Each team builds something similar, but each version carries the accidental shape of its own business project.

## 3. Existing Components Only Solve Parts of It

Cloud hosting platforms run containers, scale them, and perform health checks. Agent frameworks handle the agent loop, model calls, and tool orchestration. Databases, object stores, and message brokers handle persistence and messaging. WebSocket or SSE can stream output back to clients.

All of these capabilities should remain in place, and they are mature. The gap sits between them: who organizes workers, workspaces, event streams, reconnects, authorization, observability, audit, and recovery into a stable runtime around the session?

Without this runtime, every online agent product has to build a runtime layer beside its business logic. Early on, engineering experience can carry this. In multi-tenant, long-running, public-facing scenarios, the complexity quickly becomes a product risk.

## 4. What the Agent Runtime Actually Needs to Carry

Before discussing the product shape, it is useful to separate the objects that an agent runtime actually needs to carry. A running agent is usually composed of several kinds of things.

The first category is prompts and system prompts. They define the agent's role, task boundary, output style, tool usage pattern, and safety constraints. In application-invoked scenarios, these become productized: some come from the default configuration of the agent type, some from tenant or project configuration, and some from the user's input in the current session.

The second category is tools and MCP servers. Coding agents need to read and write files, run commands, inspect repositories, and access issues or pull requests. Enterprise agents may need to call internal systems, databases, ticketing systems, and approval workflows. MCP gives these tools a relatively unified way to connect to agents, but the tools themselves still involve permissions, credentials, network location, tenant boundaries, and audit.

The third category is skills, instructions, and memory. Claude Code's CLAUDE.md, auto memory, and skills, as well as Copilot custom instructions, custom agents, and MCP configuration, all tell the agent how the project works, what habits the team has, and how certain classes of tasks should be done. These affect the startup context of every session, and they also affect whether the agent can reliably reproduce the same kind of work.

The fourth category is session and history. Existing products already save prompts, responses, tool calls, file changes, checkpoints, or task logs. When resuming a session, the runtime reorganizes this history into model input, or uses it to restore a worksite. For a cloud service, a session also needs its own identity, status, owner, participants, access policy, and lifecycle.

The fifth category is workspace and execution environment. Agent state often lands in files, branches, worktrees, artifacts, logs, and temporary directories. For coding agents, these are closer to the real work result than the conversation transcript. A cloud runtime needs to know when to create a workspace, when to snapshot it, when to clean it up, and how to recover after worker failure.

These objects define the product boundary. One end of the runtime needs to sit close to the agent process and receive prompt context, workspace, tools/MCP/skills, and runtime events. The other end needs to face the application server and client, providing stable session identity, history, routing, authorization, audit, and connection. This lets the application server call the agent as a stable service without having to understand each agent product's internal session mechanism.

## 5. Two Customer Scenarios

It is important to separate two customer scenarios. Both encounter session, workspace, communication, and audit problems, but the value customers care about and the scope the runtime can control are different.

| Dimension | Homogeneous worker pool | User- or task-provided environment |
| --- | --- | --- |
| Environment assumption | Multiple workers of the same agent class are similar and can serve the same kind of session | The agent runs in an environment provided by the user, repository, CI system, enterprise network, developer machine, or edge device |
| What the customer is really trying to solve | Operate the agent as a scalable online service: requests can be routed, sessions are durable, and worker failure can be recovered across machines | Turn agents in distributed environments into connectable, observable, governable service endpoints: users can return to follow progress, and the platform can record events, permissions, and results |
| Runtime control | The runtime can manage workers, workspaces, capacity, and session lifecycle, so most session runtime capabilities can be implemented deeply | It is hard to assume workers are interchangeable, and hard to directly take over environment lifecycle; stable connection, event streams, identity and trust, permission boundaries, and audit matter more |
| Product strategy | Suitable as the V1 mainline to validate the core value of a durable session runtime | Suitable as a later expansion through connectors, adapters, and capability-based routing |

This distinction matters. In a homogeneous worker pool, cross-machine recovery, capacity scheduling, workspace lifecycle, and session routing are core value. In user- or task-provided environments, customers care more about whether agents can securely connect to the platform, whether long-running work is visible, whether progress can be followed after disconnects, and whether results and actions are auditable. The latter product shape is closer to a cross-environment session control plane.

## 6. Initial Target Customers

Based on the distinction above, V1 should prioritize teams turning the same class of agent into an online application. The most typical targets are coding/developer-tool agents, data/analytics agents, and enterprise workflow agents: they have long-running work, workspaces, tool events, mid-run user participation, permissions, and audit needs, and they can more easily start from a homogeneous worker pool.

This means the design should prioritize an operable cloud runtime: sessions can exist independently, workers can register and be selected, workspaces can be saved and restored, clients can connect and reconnect reliably, and permission checks enter the routing path. Once this mainline works, there is a foundation for supporting more heterogeneous environments later.

Early work should not focus on simple chatbots, stateless API wrappers, customers that already rely entirely on managed agent platforms, or highly distributed personal-device or edge-device networks. They may also need agent connection and event visibility, but they are not the best first targets for validating the core value of a durable session runtime.

## 7. Core Design Principles

First, session is a first-class object. A session cannot live only in a worker's memory. It should have its own identity, metadata, event history, workspace state, lifecycle status, and access policy.

Second, recovery should initially be based on workspace snapshots and event logs. A unified semantic context format is attractive, but it touches the internal state of different agent frameworks too early. The more practical early path is to save user-visible events and working directories, then let the adapter decide how to resume or restart based on the agent's capabilities.

Third, the sidecar should prioritize adapting existing agents. The most valuable wedge is likely the process wrapper: the sidecar launches and supervises a CLI or local process and connects it to the session runtime. This lets teams bring agents they already have into a cloud service before rewriting the agent loop.

Fourth, the initial scenario should be a homogeneous worker pool. This is closer to the early deployment model of most online agent applications, and it is easier to validate routing, scaling, and recovery.

Fifth, the central service needs built-in authentication, authorization, tenant isolation, and audit. It will often become a public-facing endpoint, so permission checks must happen on critical paths such as session creation, connection, message routing, event replay, artifact access, and worker registration.

## 8. Proposed Product Shape

Based on the priorities above, the product should first focus on a clear runtime layer:

> Agent runtime sidecar plus centralized session routing and communication service.

It can be split into four components. Instead of expanding into a responsibility checklist, it is more useful to first see which runtime pressure each component absorbs.

| Component | Problem it absorbs | Core responsibility |
| --- | --- | --- |
| Central session service | Clients and agent workers need a stable entry point | Manage sessions, workers, routing, connections, authorization, and audit |
| Agent runtime sidecar | Existing agent processes need to be connected to the cloud runtime | Prepare the runtime environment, connect the agent process, forward events, and save state |
| Persistent storage | Sessions, workspaces, and events cannot stay only on the local machine | Store the session catalog, event log, workspace snapshots, artifacts, and audit records |
| SDKs and APIs | Apps, clients, and sidecars need a stable way to connect to the runtime | Provide interfaces for creating sessions, connecting to sessions, sending events, receiving streams, and registering workers |

The central session service is the control plane and communication entry point for this runtime. Clients and application backends do not need to know where a specific agent worker is. They only need to speak in terms of sessions. The service maintains the session catalog, worker registry, and connection state. When a message enters the system, it decides which session the message belongs to, which worker it should go to, whether the current principal has permission, and which events need to enter the audit log.

The agent runtime sidecar sits close to the agent process. Its value is making it easier for existing agents to enter a cloud runtime without requiring teams to rewrite the agent loop. The sidecar can launch a CLI agent as a process wrapper, or communicate with an agent through an SDK, local HTTP, gRPC, stdio, named pipe, or socket. It prepares prompt context, workspace, and tool/MCP/skills configuration, passes events from the central service to the agent, and writes agent output, tool events, status changes, and checkpoints back to the runtime.

Persistent storage is the foundation for session continuity. It does not need to define a complex unified context schema at the beginning, but it does need to store session metadata, event history, workspace snapshots, artifacts, and audit records. This gives the system enough material to restore the worksite or explain current state after worker restarts, client disconnects, or session pauses.

SDKs and APIs make the runtime usable as a product. The client SDK handles connection, input, streaming output, approval, cancel, and reconnect. The backend API lets the application server create or manage sessions on behalf of users. The sidecar API lets workers register capability, receive routed events, report status, and submit snapshots. Together, they pull the lower-level details of routing, streaming, and recovery into the runtime boundary.

A simplified structure looks like this:

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

The benefit of this structure is that clients see a stable session endpoint, the agent process sees an environment close to local execution, and the runtime in the middle connects the two.

## 9. Typical Runtime Flow

When a new session starts, the client or application backend sends a request to the central service. The central service authenticates the request, creates a session record, and selects an available worker. The sidecar prepares the workspace and starts or connects to the agent process. After that, user input, agent output, status changes, and approvals all flow through the central service as events.

After a client disconnects, the session remains in the catalog and event log. When the user returns, they only need to reconnect with the session ID. The central service checks permissions, restores recent events, and attaches to the active worker when needed.

If a worker fails, the central service can mark the session as recoverable and select a compatible worker. The new sidecar pulls the latest workspace snapshot and event context, then lets the agent continue according to the agent's supported recovery mode. For the user, this should appear as an explainable recovery, not a vanished task.

## 10. Initial Product Scope

V1 should answer a very specific question: can a customer connect an existing agent to the runtime and run it as a durable, interactive, multi-tenant online service? Around this path, the functional priorities can be divided into four layers.

1. **Agent Integration**
   The core goal of this layer is to let customers connect an existing agent with minimal changes. The key V1 feature is the process-wrapper sidecar, which runs beside the agent worker and connects an existing agent process to the runtime.

   This layer matters most because it determines whether customers can reuse their existing agent investment and reduce the cost of trying the runtime.

   Required capabilities:
   - **Process-wrapper sidecar**: Starts or connects to an existing CLI, local process, or framework-based agent.
   - **Runtime event adapter**: Sends session events from the central service to the agent, then writes agent output, tool events, and status changes back to the central service.
   - **Workspace preparation**: Prepares the working directory, base configuration, and necessary context files before the agent starts.

2. **Session Runtime**
   This layer is handled by the central session service. Its goal is to make the session a manageable service object, instead of leaving it only in a worker's memory. It knows which workers exist, which sessions are running, and where each message should go.

   Required capabilities:
   - **Agent type**: A class of compatible agent workers, such as the same coding-agent image and tool configuration.
   - **Worker registration**: A worker declares to the central service which agent types it can serve.
   - **Heartbeat**: A worker periodically reports that it is still alive.
   - **Capacity tracking**: Records how many more sessions or tasks a worker can accept.
   - **Durable session catalog**: Stores session ID, owner, status, active worker, history pointer, and lifecycle.
   - **Session-aware routing**: Routes a new message to the active worker based on session state, or restores it to a compatible worker when needed.
   - **Streaming / bidirectional communication**: The client continuously receives agent output, and can also send input, approval, cancel, or correction.

3. **Recovery and Persistence**
   This layer stores the evidence and worksite needed for a session to continue. The early goal is to preserve enough material to restore the worksite, or to provide a clear state explanation, after worker restart, client disconnect, or session pause.

   Required capabilities:
   - **Event log**: Records user input, agent output, tool calls, tool results, approvals, errors, and lifecycle events.
   - **Workspace snapshot**: Saves files, artifacts, logs, and intermediate outputs from the agent working directory.
   - **Artifact persistence**: Saves outputs that users or systems need to retain, download, audit, or process further.
   - **Runtime metadata**: Records the agent type, worker capability, configuration version, checkpoint time, and state description needed for recovery.

   A full unified context schema can wait until demand is validated.

4. **Productized Integration and Governance**
   This layer makes the runtime safe and practical for real applications. It exposes stable interfaces to clients, application backends, and sidecars, while putting permissions, tenant boundaries, and audit into the critical path.

   Required capabilities:
   - **Client SDK/API**: Allows browser, desktop, CLI, or backend clients to create sessions, connect to sessions, send input, receive streaming output, and reconnect.
   - **Backend SDK/API**: Allows the application server to create sessions on behalf of users, query status, and manage access policy.
   - **Sidecar SDK/API**: Allows workers to register capability, receive routed events, report status, and submit snapshots.
   - **Authentication**: Confirms who is connecting.
   - **Authorization**: Determines what the principal can do to which agent, session, workspace, or artifact.
   - **Tenant isolation**: Keeps data and worker boundaries clear across customers or organizations.
   - **Audit log**: Records key events such as session creation, connection, message routing, approval, artifact access, and authorization failure.

V1 can narrow these areas first:

1. Do not provide the model provider.
2. Do not build a full agent framework or agent builder.
3. Do not build a full management UI, marketplace, or application builder.
4. Do not rush to define a unified context schema.
5. Do not include heterogeneous or edge-device agent routing in the first phase, such as simultaneously scheduling agents across local developer machines, enterprise network machines, edge devices, and different toolchains.
6. Do not make managed cloud service the first delivery form.

This scope is small enough, and distinctive enough. It first proves one product path: existing agents connect through the sidecar, sessions are managed by the central service, workspace and events can recover, clients can interact reliably, and enterprise customers have a basic loop for permissions and audit. Other agent platform capabilities should be added around this path over time.

## 11. Delivery and Deployment Path

The first delivery form for this runtime should be self-hostable software. Early customers need to validate the agent session runtime in their own cloud, development environment, or controlled network, so the product should not require customers to use a managed service from the start.

The deployment path can have three steps. The first step is single-instance development mode, for local development, demos, and early evaluation: one central service instance, local or embedded metadata storage, local workspace storage, and one or more sidecar workers. The value of this mode is letting teams quickly validate whether an existing agent can connect to the session runtime through the sidecar.

The second step is production cluster mode. In production, the central service needs to run as multiple instances behind a load balancer, using a shared session catalog, shared event log or broker, shared workspace storage, and a worker registry plus heartbeat. This stage must introduce tenant-aware authentication, authorization, and audit.

The third step is managed cloud service. If self-hosted adoption proves that customers need this runtime but do not want to operate the control plane long term, a managed cloud-native service can be offered. The managed service should reuse the same session/runtime model and keep the product boundary stable.

## 12. Differentiation

This product's differentiation comes from the operational runtime rather than agent intelligence itself.

It can help teams bring existing CLI agents, local agents, or framework-based agents into the cloud while preserving their existing agent investment. It remains neutral to model providers, agent frameworks, and cloud platforms, which makes it easier to enter existing technology stacks.

Compared with AX-like distributed agent executors, this product sits closer to the application-facing durable session runtime: it adapts existing agents through a sidecar and focuses on client/session routing, workspace recovery, tenant-aware auth/audit, and service delivery.

It puts durable workspace, session recovery, real-time interaction, approval flow, authorization, and audit into the same session runtime. Each of these capabilities can be assembled from existing infrastructure on its own, but together they define a runtime boundary that online agent products repeatedly need.

This also lets the product avoid the most crowded model orchestration competition. It serves the runtime problems exposed when agents move from prototype to production.

## 13. Questions to Validate

First, are target customers willing to introduce an independent runtime layer instead of continuing to build that layer inside their business systems? This question determines product packaging, deployment model, and SDK design.

Second, how far can session recovery actually go? This is likely the hardest validation point. Workspace snapshots plus event logs can preserve user-visible history and the worksite, but they may not capture agent-internal state, tool state, unfinished tool calls, temporary memory, or semantics after model-context compaction. The MVP needs to clarify which recoveries are true continuation and which are restart with context; it also needs to define what capability an agent adapter must provide before the runtime can safely restore a session onto another worker.

Third, the protocol strategy should stay restrained. The product can start with a small internal event model while tracking existing protocols such as AG-UI, A2A, MCP, and ACP. Protocol compatibility can be an adoption accelerator, but the early value should still land on durable session runtime.

Fourth, the authorization model needs to be clear enough without turning into another enterprise policy engine. A practical starting point is tenant, principal, agent type, session, role/capability, plus an application-provided authorization hook.

Fifth, can a homogeneous worker pool cover the earliest high-value scenarios? Coding agents, data agents, and enterprise workflow agents all have potential, but the first validation scenario should be focused.

## 14. Recommended Next Step

Start with a self-hosted MVP and choose a workspace-heavy, long-running agent scenario that needs real-time user participation as the validation target. A coding/developer-tool agent is a natural starting point because it combines files, commands, logs, approvals, reconnects, and recovery needs.

The MVP criteria can be simple: can an existing agent connect through the sidecar; can users create sessions, reconnect after disconnect, and keep receiving output; can the system restore workspace and provide clear status after worker failure; can the business system enforce permissions at the session and artifact level?

If this path works, later work can add more complex protocol adapters, management UI, managed service, heterogeneous routing, and stronger context portability. First make the durable session runtime solid, and the product boundary will become naturally clear.