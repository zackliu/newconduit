---
description: "Use when writing or editing Agent Runtime Sidecar product specs, architecture docs, ADRs, bilingual Chinese/English proposals, or markdown design documents."
applyTo: "*.md,docs/**/*.md"
---
# Product Spec Writing

- Preserve design decisions, not just wording. If a sentence carries a product boundary, validate the boundary before editing style.
- Treat `agent-runtime-sidecar-brief-ch.md` and `agent-runtime-sidecar-brief-en.md` as the current thesis; treat the longer proposal files as background unless the task says otherwise.
- Keep the product centered on durable agent sessions, central session routing, sidecar-based agent adaptation, workspace/event recovery, tenant-aware authorization, and audit.
- Avoid expanding the MVP into model hosting, an agent framework, a hosting platform, a marketplace, or a general app builder.
- Write specs as polished target-state artifacts, not revision records. If discussion changes the design, fold the decision into the relevant section as if it had always been the intended design.
- Do not append "修改说明", "补充说明", "根据最新讨论", "revision note", changelog-style paragraphs, or stacked caveats inside the spec body unless the user explicitly asks for a revision history.
- Remove or rewrite obsolete statements instead of preserving them with later corrections. A reader should not need to reconstruct the conversation timeline to understand the current design.
- When changing Chinese and English counterparts, inspect both. Either update both or explicitly state that only one language version was intentionally changed.
- Chinese product prose should be natural Chinese with stable English technical terms where they are clearer: session, worker, sidecar, runtime, workspace, event log, snapshot, authorization, audit, SDK, API, MCP.
- Do not turn a design document into marketing copy. Prefer mechanism, boundary, tradeoff, validation path, and operational implications.
- For tables that compare components or scenarios, keep row meaning parallel across columns and avoid adding one-off exceptions that hide a missing primitive.