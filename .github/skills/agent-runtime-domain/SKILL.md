---
name: agent-runtime-domain
description: "Use when designing or implementing Agent Runtime Sidecar domain work: durable sessions, central session service, worker registry, sidecar process wrapper, workspace snapshots, event logs, auth/audit, SDKs, APIs, recovery, or Conduit rewrite boundaries."
argument-hint: "design or implementation topic"
---
# Agent Runtime Domain

Use this skill for domain decisions in this repo. Load the current brief docs before making architectural claims.

## Domain Invariants

- Session is the durable object; worker compute is replaceable.
- Tenant is a high-level runtime boundary. Most runtime state, registries, controllers, adapters, storage, transport config, policy, audit, worker capacity, and AgentSpec defaults are tenant-scoped. The outer central layer handles tenant discovery, tenant creation, tenant registry, and cross-tenant administration, then delegates to tenant runtimes.
- Central session service is the public/session-facing control plane and communication entry point.
- Sidecar sits close to the agent process and adapts existing agents into the runtime.
- Persistent storage provides session metadata, event log, workspace snapshots, artifacts, runtime metadata, and audit records.
- SDK/API surfaces exist for clients, application backends, and sidecars.
- Customer-facing SDK code lives under `sdk/` and stays separate from service-provider runtime code under `src/`. Shared understanding comes from public protocol specs and e2e tests, not code imports from `src/`.
- V1 focuses on homogeneous worker pools and self-hostable deployment.
- Recovery begins with workspace snapshots and event logs. Unified semantic context is a later validation area.
- Conduit is design reference material, not the implementation base.

## Component Boundaries

### Central Session Service

Owns tenant discovery, tenant runtime registry, public entrypoints, and cross-tenant administration. Within a tenant, the tenant runtime owns session catalog, worker registry, connection state, routing, authorization, audit, event replay, storage adapters, transport adapters, and artifact access checks.

Within a tenant runtime, keep protocol-facing replacement boundaries separate from internal runtime mechanisms. Use `Controller` for replaceable protocol or ingress handlers that translate external shapes such as REST requests, Web PubSub runtime events, sidecar commands, or future gRPC/queue/A2A/AG-UI inputs into tenant-internal commands. Use `Manager` for cohesive tenant-owned workflows and state mechanisms such as session lifecycle, turn sequencing, assignment, event logging, worker registry state, and worker leases. `TenantRuntime` is the tenant composition root and ingress shell; it owns controllers and managers but should not implement every command workflow itself.

### Agent Runtime Sidecar

Owns process lifecycle, local IPC/stdio/HTTP/gRPC bridge, workspace preparation, agent configuration injection, event translation, status reporting, capacity reporting, checkpoint submission, and snapshot submission.

### Persistent Storage

Owns session metadata, append-only event history, workspace snapshots, artifacts, audit records, retention policy, and restore inputs.

### SDK and API

Owns stable client, backend, and sidecar contracts. The SDK should hide routing and reconnect details without hiding authorization or recovery state.

### Customer-Facing SDK Design

Design SDK public methods from the point of view of an agentic application author before mapping them to runtime events or transport calls. The app author usually needs to start or attach to a durable session, send user input or structured app events, stream assistant output and session milestones, inspect readiness/status, reconnect after refresh or backend restart, pause/resume/cancel work, and access workspace or artifact references. A natural SDK should make those app workflows read like product code, not like hand-authored runtime protocol envelopes.

Public methods should name developer intent rather than transport mechanics. Prefer session handles, typed operation results, async iterables, callbacks, or scoped subscriptions that represent durable-session behavior. Keep raw runtime events, cursors, Web PubSub groups, worker assignment, worker addresses, and sequence plumbing behind the SDK boundary except for an explicitly named low-level or diagnostics surface. The SDK can hide negotiate, routing, reconnect, and event demultiplexing details, but it must still surface authorization failures, recovery state, terminal failures, and durable session identity clearly.

For the current Web PubSub POC, REST is only for negotiate. Session create, input, pause, resume, cancel, and turn event flow must use the Web PubSub runtime event path. Do not introduce a parallel HTTP command path for the same session lifecycle operation.

Before accepting a client SDK method, sketch the app code a real agentic product would want to write. If the call site forces the app to construct `session.create.requested` payloads, manually correlate request ids, subscribe to raw event envelopes just to learn the session id, or understand worker/runtime channel names, the public method is still too naked and belongs in a lower-level protocol layer.

## Design Checks

For any proposal or implementation, answer:

1. What durable object is being changed: session, worker, agent type, workspace, event, artifact, audit record, or configuration?
2. Which ownership boundary owns this object or class: outer central, tenant runtime, sidecar, or shared contract?
3. If it reads/writes AgentSpec, Session, Worker, Event, WorkspaceSnapshot, Policy, Audit, transport config, storage, or hosting config, why is it not tenant-scoped?
4. Does the change preserve the separation between session identity and worker location?
5. Where is authorization enforced before routing or access?
6. What is persisted before a worker dies?
7. Is recovery a true continuation, restart with context, or non-recoverable failure?
8. Does the sidecar still allow existing agent processes to be adapted with minimal changes?
9. Does the design require a model provider, agent framework, hosting platform, or marketplace responsibility that is out of scope?
10. Is the proposal adding fallback behavior or compatibility layers instead of fixing the model or implementation?
11. Are validation plans based on business behavior and public contracts rather than source-code shape?
12. What is the smallest self-hosted MVP slice that validates this?
13. For SDK/API changes, what would the natural app-code call site look like before it is lowered to protocol events?
14. Which details are app concepts, and which details are runtime plumbing that should stay out of the default public SDK surface?
15. Is a new class a protocol-facing replaceable controller, a tenant-internal workflow/state manager, a pure policy/selector, or the tenant composition root?

## Anti-Patterns

- Putting tenant-owned adapters/controllers directly in the outer central layer because it is convenient to wire them there.
- Passing `tenantId`, principal, owner, or tenant config as client-supplied business payload when those values should come from tenant resolution or connection/auth context.
- Encoding a worker address into client-facing session APIs.
- Treating conversation transcript as the whole session state.
- Adding a broad protocol or context standard before validating runtime value.
- Putting tenant policy only in the application backend while central routing remains blind.
- Making sidecar integration require a full rewrite of the agent loop.
- Reusing Conduit directory or protocol assumptions without revalidating the product boundary.
- Adding fallback paths, compatibility shims, or dual behavior because the current design is unclear.
- Keeping placeholder sidecar, central, storage, transport, worker, session, and test paths after the real runtime path exists.
- Letting a sidecar daemon, tenant runtime controller, central service, or runtime orchestrator directly construct Web PubSub, Docker, Copilot, storage, or hosting adapters instead of receiving a role-named dependency.
- Calling a tenant-internal workflow or state mechanism a controller when it is not a replaceable protocol boundary; use manager/policy/selector names for those roles.
- Letting `TenantRuntime` accumulate protocol parsing, command workflow, event persistence, acknowledgements, and worker routing logic instead of delegating to tenant-owned controllers and managers.
- Naming runtime fields after a current implementation such as WebPubSub, Docker, or Copilot when the field represents a replaceable transport, workspace, hosting, or agent-process role.
- Changing public REST endpoints, query keys, runtime channel mapping, event names, or payload schemas without updating `sdk/public-protocol-spec-ch.md`, SDK code, runtime handlers, and e2e tests together.
- Designing customer-facing SDK methods by directly exposing current runtime event names, channel names, cursors, request correlation, worker assignment, or Web PubSub mechanics as the default app API.
- Adding both HTTP and Web PubSub command handlers for the same client-facing session lifecycle operation instead of choosing one public command path.
- Adding conditional logic that hides inconsistent state instead of naming and fixing the invalid state transition.
- Testing private helper shape, source snippets, or implementation structure instead of session/runtime behavior.

## Output Format

```markdown
## Domain Decision Summary
- Decision:
- Durable objects affected:
- Component boundary:
- Recovery semantics:
- Authorization/audit path:
- Root-cause stance:
- Business-logic validation:
- MVP validation:
- Risks or open questions:
```