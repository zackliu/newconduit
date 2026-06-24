---
description: "Use when adding or modifying future implementation code for the central session service, sidecar, persistent storage, SDKs, APIs, protocols, authorization, audit, or tests."
applyTo: "src/**,packages/**,services/**,sidecar/**,sdk/**,tests/**,**/*.ts,**/*.tsx,**/*.cs,**/*.go,**/*.rs,**/*.py"
---
# Implementation Change Guidelines

- Do not treat design discussion as an implementation request. If the user is still debating architecture, terminology, workflow, or product boundary, stay in design/spec mode and do not edit implementation code. Edit code only after the user explicitly asks for implementation or the design discussion has converged into a clear implementation slice.
- Start from the runtime contract. Identify whether the change belongs to central service, sidecar, storage, SDK/API, protocol adapter, auth/audit, deployment, or tests.
- Before adding or wiring a class, identify its ownership boundary: outer central, tenant runtime, sidecar, or shared contract. Runtime state and implementation adapters are tenant-scoped by default. If a class reads/writes AgentSpec, Session, Worker, Event, WorkspaceSnapshot, Policy, Audit, transport config, storage, or hosting config, place it behind `TenantRuntime` or another tenant-owned boundary unless the design explicitly says it is cross-tenant.
- Keep the outer central layer thin. It may create/resolve tenants, hold a tenant runtime registry, dispatch connections/events to a tenant, and expose cross-tenant administration. It must not directly use tenant-owned adapters/controllers such as WebPubSub transport, local storage, AgentSpec registry, Worker registry, Docker hosting, snapshot, policy, or audit implementations.
- Keep durable session identity separate from ephemeral worker identity.
- Route through explicit session and worker metadata. Do not let clients depend on worker location or process-local state.
- Use structured events and typed payloads for session communication. Avoid ad hoc string parsing for protocol or storage boundaries.
- Enforce authorization before routing, replaying events, exposing artifacts, or registering workers.
- Make recovery semantics explicit: true continuation, restart with context, or non-recoverable failure.
- Do not implement fallback code, compatibility shims, legacy compatibility layers, dual behavior paths, or silent best-effort behavior unless the user explicitly asks for a migration or compatibility plan.
- Do not design for backward compatibility by default. This repo is allowed to make clean contract changes while the product is being shaped.
- When fixing a bug, investigate in this order: design/model flaw, implementation flaw, missing explicit domain validation. Add a conditional branch only when the domain rule itself requires that branch.
- Prefer failing fast with a clear error over silently recovering into a state that hides a broken contract.
- Add tests at the contract boundary touched by the change. Prefer integration or adapter-level tests for session routing, recovery, sidecar interaction, auth, and wire contract behavior.
- Tests must be based on business logic and public behavior: session lifecycle, routing outcome, authorization decision, recovery semantics, event persistence, artifact access, or SDK contract. Avoid tests that assert source-code structure, private helper calls, string snippets, or line-level implementation details.
- Update docs and `AGENTS.md` with any newly verified bootstrap, build, test, lint, schema, or run commands.