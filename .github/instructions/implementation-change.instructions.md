---
description: "Use when adding or modifying future implementation code for the central session service, sidecar, persistent storage, SDKs, APIs, protocols, authorization, audit, or tests."
applyTo: "src/**,packages/**,services/**,sidecar/**,sdk/**,tests/**,**/*.ts,**/*.tsx,**/*.cs,**/*.go,**/*.rs,**/*.py"
---
# Implementation Change Guidelines

- Start from the runtime contract. Identify whether the change belongs to central service, sidecar, storage, SDK/API, protocol adapter, auth/audit, deployment, or tests.
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