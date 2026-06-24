---
name: spec-consistency
description: "Use when checking or updating consistency across Chinese and English specs, proposal docs, terminology, product boundaries, tables, headings, or duplicated architecture descriptions."
argument-hint: "files or topic to compare"
---
# Spec Consistency

Use this skill when editing bilingual docs, reconciling proposal drift, or reviewing whether product terms and boundaries remain aligned.

## Procedure

1. Identify the document family:
   - Brief docs: `agent-runtime-sidecar-brief-ch.md`, `agent-runtime-sidecar-brief-en.md`.
   - Proposal docs: `proposal-ch.md`, `agent-runtime-sidecar-proposal.md`.
2. Determine which file is intended as source of truth for the current task.
3. Compare headings, tables, component names, product scope, non-goals, and next steps.
4. Track terminology drift:
   - session, worker, sidecar, central session service, event log, workspace snapshot, artifact, audit, SDK/API.
5. Normalize each spec into a final-state document. Remove obsolete claims, late addenda, and revision-note wording instead of mirroring them across languages.
6. Update counterparts only when the task asks for synchronization or when leaving them inconsistent would mislead future work.
7. If only one file changes, state the intentional asymmetry outside the spec body.

## Consistency Checks

- Does V1 remain focused on homogeneous worker pools?
- Does the design still prefer process-wrapper sidecar integration first?
- Does recovery still start from workspace snapshots and event logs?
- Are unified protocol and unified context still validation questions rather than V1 commitments?
- Is Conduit still framed as design reference, not direct implementation base?
- Are authentication, authorization, tenant isolation, and audit in central routing paths?
- Do the documents read as current product specs rather than accumulated revision logs?

## Output Format

```markdown
## Spec Consistency Report
- Files compared:
- Source of truth:
- Aligned sections:
- Drift found:
- Edits made or recommended:
- Intentional non-sync:
```