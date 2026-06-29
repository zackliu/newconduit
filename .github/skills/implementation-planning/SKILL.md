---
name: implementation-planning
description: "Use when turning a complex design into code work, decomposing a large feature, planning implementation slices, mapping tests, or preparing a low-risk Copilot/Codex coding task in a complex repo."
argument-hint: "feature or design to implement"
---
# Implementation Planning

Use this skill before writing non-trivial code, especially for shared contracts, runtime infrastructure, storage, SDKs, auth/audit, protocol adapters, or explicitly requested migrations.

## Procedure

1. Link the implementation to a source design decision or doc section.
2. Map affected boundaries: central service, sidecar, storage, SDK/API, protocol, auth/audit, deployment, tests, docs.
3. Establish the root-cause stance before designing the fix: design/model flaw first, implementation flaw second, missing explicit domain validation third.
4. Identify existing patterns and reusable helpers before creating new abstractions.
5. Define the smallest coherent implementation slice that can be reviewed independently.
6. Define the contract first: types, events, endpoints, schema, storage shape, or adapter interface.
7. Define validation for the slice before editing: unit tests, integration tests, schema generation, lint, build, manual smoke test.
8. Implement one slice, validate it, then update docs/instructions with verified commands or discovered caveats.
9. Retire scaffolding that the slice replaces: remove placeholder methods, stub entrypoints, demo half-paths, stale field names, and obsolete docs in the same change.
10. Keep replaceable components replaceable: controllers, daemons, services, and orchestrators depend on interfaces or shared contracts; composition roots choose concrete POC adapters.
11. For customer-facing SDK work, keep `sdk/client/` separate from `src/`: SDK code must not import service-provider runtime implementation. Public protocol changes must update `sdk/client/public-protocol-spec-ch.md`, SDK types, runtime handlers, and e2e tests together.
12. Before naming a central runtime class, decide whether it is a protocol-facing controller, tenant-internal manager, pure policy/selector, adapter, or composition root. Use `Controller` only for replaceable protocol/ingress boundaries. Use `Manager` for cohesive tenant-owned workflows and state mechanisms such as session lifecycle, turn sequence, assignment, event log, worker registry state, and leases. `TenantRuntime` should compose and delegate, not implement command workflows directly.

## Slice Rules

- Keep each slice focused on one durable behavior or contract.
- Avoid mixing mechanical rewrites with semantic changes.
- Avoid adding broad extension points until at least two real call sites need them.
- Do not silently change wire formats, event names, storage layouts, or recovery semantics.
- Do not add fallback code, compatibility shims, legacy compatibility layers, or dual behavior paths unless the user explicitly asks for migration/compatibility work.
- Do not leave a placeholder path beside the real implementation. A slice is not complete until superseded stubs, demo-only shortcuts, stale naming, and obsolete tests/docs are removed.
- Do not instantiate concrete adapters inside controllers, daemons, services, or orchestrators. Inject the dependency behind a role-named interface, and keep concrete construction in `main`, tests, factories, or tenant runtime composition code.
- Do not call a tenant-internal state mechanism a controller merely because it contains logic. If it does not translate a replaceable ingress/protocol shape into internal commands, it is a manager, policy, selector, or adapter.
- Name fields by role, not implementation. Prefer `runtimeTransport`, `workspaceAdapter`, `agentProcessAdapter`, and `volumeAdapter` over `webPubSubAdapter`, `dockerWorkspaceAdapter`, and `copilotProcessAdapter` unless the class itself is that concrete adapter.
- Do not add conditional checks to mask a broken design or implementation. Add a branch only when it represents an explicit domain rule.
- Plan tests from business behavior and public contracts, not from source-code structure or private helper implementation.
- After replacing scaffolding, search the repo for old identifiers, placeholder words, and stale contract fields, then clean the matching docs and tests.
- Do not let SDK protocol drift from runtime protocol. Any change to public REST endpoints, query keys, runtime channels, event types, or payload schemas must update the SDK public protocol spec and the SDK-to-runtime e2e path in the same slice.
- For large changes, propose a sequence rather than one massive diff.

## Output Format

```markdown
## Implementation Plan
- Source design:
- Root-cause stance:
- Affected boundaries:
- Proposed slices:
- First slice:
- Contract changes:
- Business-logic tests:
- Validation commands:
- Risks:
- Docs to update:
```