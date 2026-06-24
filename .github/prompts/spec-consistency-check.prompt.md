---
description: "Check consistency across Chinese and English Agent Runtime Sidecar specs."
name: "Spec Consistency Check"
argument-hint: "files or topic"
agent: "agent"
---
# Spec Consistency Check

Check consistency for:

`${input:scope:Which files, sections, or topic should be compared?}`

Use the `spec-consistency` skill.

Return:

```markdown
## Spec Consistency Report
- Files compared:
- Source of truth:
- Terminology drift:
- Product-boundary drift:
- Sections that should be updated:
- Suggested edits:
```