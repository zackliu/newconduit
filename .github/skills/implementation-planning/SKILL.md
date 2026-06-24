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

## Slice Rules

- Keep each slice focused on one durable behavior or contract.
- Avoid mixing mechanical rewrites with semantic changes.
- Avoid adding broad extension points until at least two real call sites need them.
- Do not silently change wire formats, event names, storage layouts, or recovery semantics.
- Do not add fallback code, compatibility shims, legacy compatibility layers, or dual behavior paths unless the user explicitly asks for migration/compatibility work.
- Do not add conditional checks to mask a broken design or implementation. Add a branch only when it represents an explicit domain rule.
- Plan tests from business behavior and public contracts, not from source-code structure or private helper implementation.
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