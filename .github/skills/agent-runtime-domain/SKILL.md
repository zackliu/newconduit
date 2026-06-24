---
name: agent-runtime-domain
description: "Use when designing or implementing Agent Runtime Sidecar domain work: durable sessions, central session service, worker registry, sidecar process wrapper, workspace snapshots, event logs, auth/audit, SDKs, APIs, recovery, or Conduit rewrite boundaries."
argument-hint: "design or implementation topic"
---
# Agent Runtime Domain

Use this skill for domain decisions in this repo. Load the current brief docs before making architectural claims.

## Domain Invariants

- Session is the durable object; worker compute is replaceable.
- Central session service is the public/session-facing control plane and communication entry point.
- Sidecar sits close to the agent process and adapts existing agents into the runtime.
- Persistent storage provides session metadata, event log, workspace snapshots, artifacts, runtime metadata, and audit records.
- SDK/API surfaces exist for clients, application backends, and sidecars.
- V1 focuses on homogeneous worker pools and self-hostable deployment.
- Recovery begins with workspace snapshots and event logs. Unified semantic context is a later validation area.
- Conduit is design reference material, not the implementation base.

## Component Boundaries

### Central Session Service

Owns session catalog, worker registry, connection state, routing, authorization, tenant isolation, audit, event replay, and artifact access checks.

### Agent Runtime Sidecar

Owns process lifecycle, local IPC/stdio/HTTP/gRPC bridge, workspace preparation, agent configuration injection, event translation, status reporting, capacity reporting, checkpoint submission, and snapshot submission.

### Persistent Storage

Owns session metadata, append-only event history, workspace snapshots, artifacts, audit records, retention policy, and restore inputs.

### SDK and API

Owns stable client, backend, and sidecar contracts. The SDK should hide routing and reconnect details without hiding authorization or recovery state.

## Design Checks

For any proposal or implementation, answer:

1. What durable object is being changed: session, worker, agent type, workspace, event, artifact, audit record, or configuration?
2. Does the change preserve the separation between session identity and worker location?
3. Where is authorization enforced before routing or access?
4. What is persisted before a worker dies?
5. Is recovery a true continuation, restart with context, or non-recoverable failure?
6. Does the sidecar still allow existing agent processes to be adapted with minimal changes?
7. Does the design require a model provider, agent framework, hosting platform, or marketplace responsibility that is out of scope?
8. Is the proposal adding fallback behavior or compatibility layers instead of fixing the model or implementation?
9. Are validation plans based on business behavior and public contracts rather than source-code shape?
10. What is the smallest self-hosted MVP slice that validates this?

## Anti-Patterns

- Encoding a worker address into client-facing session APIs.
- Treating conversation transcript as the whole session state.
- Adding a broad protocol or context standard before validating runtime value.
- Putting tenant policy only in the application backend while central routing remains blind.
- Making sidecar integration require a full rewrite of the agent loop.
- Reusing Conduit directory or protocol assumptions without revalidating the product boundary.
- Adding fallback paths, compatibility shims, or dual behavior because the current design is unclear.
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