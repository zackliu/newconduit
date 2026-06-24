---
name: product-design-review
description: "Use when reviewing or creating product architecture, MVP scope, PRD, ADR, design proposal, tradeoff analysis, protocol decision, auth model, deployment plan, or roadmap for a complex agent runtime product."
argument-hint: "proposal, decision, or area to review"
---
# Product Design Review

Use this skill when a design needs more than wording polish. The goal is to test whether the design holds together as a product and runtime system.

## Procedure

1. Restate the decision or proposal in one paragraph.
2. Identify the customer scenario and whether it is V1 homogeneous worker pool, later heterogeneous/edge, or out of scope.
3. Separate mechanism from net effect. If a desired result appears as a special case, look for the underlying primitive.
4. For any bug, gap, or confusing behavior, review the design/model first, the implementation second, and missing explicit domain validation third.
5. Compare at least two options when the decision is meaningful.
6. Review operational consequences: routing, recovery, storage, auth, audit, deployment, observability, SDK, and any explicitly requested migration.
7. If the decision changes a spec, describe the target-state edit. Do not suggest adding revision notes, addenda, or "latest discussion" paragraphs to the spec body.
8. Decide whether the proposal should change docs, contracts, implementation, tests, or all of them.

## Review Rubric

- **Problem clarity**: Is the pain specific, repeated, and owned by target customers?
- **Runtime boundary**: Does the design stay centered on durable session runtime instead of agent intelligence?
- **MVP focus**: Does it validate existing-agent sidecar integration, durable session routing, reconnect, workspace recovery, and auth/audit?
- **Recovery honesty**: Does it name true continuation vs restart with context?
- **Auth path**: Are authorization checks in the routing and access paths?
- **Root-cause integrity**: Does the design fix the underlying model or implementation issue instead of adding fallback behavior?
- **No compatibility drift**: Does it avoid compatibility shims, legacy layers, dual paths, and default backward-compatibility work unless explicitly requested?
- **Business-logic tests**: Are validation examples based on user-visible behavior, runtime invariants, and public contracts instead of source-code shape?
- **Spec as finished artifact**: Would the resulting spec read as the current intended design rather than a record of how the design changed?
- **Protocol restraint**: Does it avoid standardizing broad protocols before demand is validated?
- **Operability**: Can it be self-hosted first, then clustered, then possibly managed?
- **Conduit boundary**: Does it borrow principles without inheriting old host-centric assumptions?

## Output Format

```markdown
## Design Review
- Verdict:
- Strongest part:
- Highest-risk assumption:
- Boundary corrections:
- Suggested edit or implementation slice:
- Open questions:
```