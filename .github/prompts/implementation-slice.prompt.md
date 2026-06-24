---
description: "Plan the first safe implementation slice for a complex feature or runtime contract."
name: "Implementation Slice"
argument-hint: "feature or contract"
agent: "agent"
---
# Implementation Slice

Plan the first reviewable implementation slice for:

`${input:feature:Describe the feature, contract, or change}`

Use `implementation-planning` and `agent-runtime-domain` when relevant.

Respect the repo rule that implementation work should not add fallback code, compatibility shims, legacy compatibility layers, or source-shape tests unless explicitly requested.

Return:

```markdown
## First Slice Plan
- Goal:
- Root-cause stance:
- Files or packages likely affected:
- Contract shape:
- Implementation steps:
- Business-logic tests:
- Validation commands:
- Risks:
- Follow-up slices:
```