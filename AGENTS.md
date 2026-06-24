# Agent Operating Guide

This repository is the design and future implementation workspace for **Agent Runtime Sidecar**, a runtime layer for running stateful, interactive agents as durable online services.

## Source of Truth

- Treat `agent-runtime-sidecar-brief-ch.md` and `agent-runtime-sidecar-brief-en.md` as the current product boundary and thesis.
- Treat `proposal-ch.md` and `agent-runtime-sidecar-proposal.md` as expanded background material that may contain older or broader framing.
- The old `C:\Users\chenyl\conduit` project is design input only. Do not assume this repo should be an incremental rewrite of that codebase.
- For AI collaboration practices, see `docs/ai-agent-development-playbook.md`.

## How to Work in This Repo

- Before a large design or code change, map the relevant docs, future packages, contracts, tests, and validation commands. Use the `repo-onboarding` skill when the repo shape is unclear.
- For Agent Runtime Sidecar domain decisions, use the `agent-runtime-domain` skill. Keep the session/runtime boundaries explicit.
- For product architecture or MVP tradeoff review, use the `product-design-review` skill.
- For future implementation work, use the `implementation-planning` skill to split changes into small, reviewable slices.
- For Chinese/English proposal drift or terminology checks, use the `spec-consistency` skill.
- Prefer precise edits to the smallest coherent set of files. If a design change affects multiple docs, update the related documents or explicitly call out why they are intentionally not synchronized.
- Do not add build, test, lint, or deployment claims until they are verified in this repo. When code is added, update this file with the exact working commands.

## Product Invariants

- A session is the durable identity. A worker is replaceable compute.
- Recovery starts from event logs and workspace snapshots. A unified semantic context format is a later validation item, not a V1 assumption.
- The central session service owns session catalog, worker registry, routing, connection state, authorization, and audit boundaries.
- Authorization must be enforced on session creation, connection, message routing, event replay, artifact access, and worker registration.
- The sidecar adapts existing agent processes first. The process-wrapper path is the preferred initial wedge.
- V1 should focus on homogeneous worker pools, self-hostable deployment, workspace-heavy long-running agents, and clear recovery semantics.
- Do not turn the product into a model provider, a full agent framework, a hosting platform, a marketplace, or a general application builder.

## Future Code Guidelines

- Define stable runtime contracts before implementation: session catalog, worker registry, routed event model, sidecar protocol, storage adapter, and SDK surface.
- Keep central service, sidecar, persistent storage, and SDK/API concerns separated. Avoid leaking worker-local assumptions into public APIs.
- Prefer structured payloads, schemas, and typed event models over ad hoc strings.
- Keep model-visible context bounded. Any future prompt, context, memory, or event replay path needs explicit size limits and summarization behavior.
- Design for tenant isolation, auditability, and recovery from the first implementation slice.
- Avoid hidden special cases that encode a desired net effect directly. Model policy, subsidy, or override behavior as explicit mechanisms.
- Do not write fallback code, compatibility shims, legacy compatibility layers, dual behavior paths, or "just in case" recovery branches unless the user explicitly asks for a migration or compatibility plan.
- When something fails, debug in this order: first ask whether the design/model is wrong, then whether the implementation violates the design, and only then whether an explicit domain validation branch is missing.
- Fix errors at the root cause. Do not add guard logic that merely hides an inconsistent state or papers over a broken contract.
- Tests must assert business behavior, runtime invariants, and public contract outcomes. Do not write tests that pass by asserting source-code shape, private helper structure, or implementation text unless the source shape is itself the generated business contract.

## Current Validation State

- The current repo is documentation-only. There is no verified build or test command yet.
- When implementation code appears, add the required bootstrap, build, test, lint, and run commands here after validating them locally.