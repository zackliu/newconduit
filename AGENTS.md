# Agent Operating Guide

This repository is the design and future implementation workspace for **Agent Runtime Sidecar**, a runtime layer for running stateful, interactive agents as durable online services.

## Source of Truth

- Treat `agent-runtime-sidecar-brief-ch.md` and `agent-runtime-sidecar-brief-en.md` as the current product boundary and thesis.
- Treat `proposal-ch.md` and `agent-runtime-sidecar-proposal.md` as expanded background material that may contain older or broader framing.
- The old `C:\Users\chenyl\conduit` project is design input only. Do not assume this repo should be an incremental rewrite of that codebase.
- For AI collaboration practices, see `docs/ai-agent-development-playbook.md`.

## How to Work in This Repo

- Treat architecture/product/runtime design discussion as design work, not as permission to change implementation. During design discussion, clarify the model, tradeoffs, terminology, workflow, and target-state docs first. Do not edit `src/`, tests, package config, or implementation files until the user explicitly asks to implement/code/change files, or the design has clearly converged into an implementation task.
- Before a large design or code change, map the relevant docs, future packages, contracts, tests, and validation commands. Use the `repo-onboarding` skill when the repo shape is unclear.
- For Agent Runtime Sidecar domain decisions, use the `agent-runtime-domain` skill. Keep the session/runtime boundaries explicit.
- For product architecture or MVP tradeoff review, use the `product-design-review` skill.
- For future implementation work, use the `implementation-planning` skill to split changes into small, reviewable slices.
- For Chinese/English proposal drift or terminology checks, use the `spec-consistency` skill.
- Write specs as finished target-state documents. When discussion changes the design, rewrite the affected sections into their final form instead of appending revision notes, addenda, or "based on the latest discussion" explanations.
- Prefer precise edits to the smallest coherent set of files. If a design change affects multiple docs, update the related documents or explicitly call out why they are intentionally not synchronized.
- Do not add build, test, lint, or deployment claims until they are verified in this repo. When code is added, update this file with the exact working commands.

## Product Invariants

- A session is the durable identity. A worker is replaceable compute.
- Tenant is a high-level runtime boundary, not a small request field. Default to tenant-scoped ownership for runtime state and adapters; only tenant discovery, tenant creation, tenant registry, and cross-tenant operations belong to the outer central layer.
- Recovery starts from event logs and workspace snapshots. A unified semantic context format is a later validation item, not a V1 assumption.
- The central session service owns session catalog, worker registry, routing, connection state, authorization, and audit boundaries.
- Authorization must be enforced on session creation, connection, message routing, event replay, artifact access, and worker registration.
- The sidecar adapts existing agent processes first. The process-wrapper path is the preferred initial wedge.
- V1 should focus on homogeneous worker pools, self-hostable deployment, workspace-heavy long-running agents, and clear recovery semantics.
- Do not turn the product into a model provider, a full agent framework, a hosting platform, a marketplace, or a general application builder.

## Future Code Guidelines

- Do not start implementation from an unresolved design conversation. Confirm the design decision or implementation slice first, then edit code.
- Define stable runtime contracts before implementation: session catalog, worker registry, routed event model, sidecar protocol, storage adapter, and SDK surface.
- Keep central service, sidecar, persistent storage, and SDK/API concerns separated. Avoid leaking worker-local assumptions into public APIs.
- Before placing any class, controller, adapter, registry, or config, decide its ownership boundary first: outer central, tenant runtime, sidecar, or shared contract. If it reads/writes AgentSpec, Session, Worker, Event, WorkspaceSnapshot, Policy, Audit, transport config, storage, or hosting config for runtime execution, it is tenant-scoped by default and should be reached through `TenantRuntime` or a tenant-owned class.
- The outer central layer must not directly instantiate or call tenant-owned adapters/controllers such as WebPubSub transport, storage, AgentSpec registry, Worker registry, policy hooks, audit sinks, Docker hosting, or snapshot adapters. It should resolve/create tenants and delegate to tenant runtime instances.
- Prefer structured payloads, schemas, and typed event models over ad hoc strings.
- Use explicit named exports in barrel files. Do not use `export * from ...`; list concrete classes and types so public contracts stay reviewable.
- Keep model-visible context bounded. Any future prompt, context, memory, or event replay path needs explicit size limits and summarization behavior.
- Design for tenant isolation, auditability, and recovery from the first implementation slice.
- Avoid hidden special cases that encode a desired net effect directly. Model policy, subsidy, or override behavior as explicit mechanisms.
- Do not write fallback code, compatibility shims, legacy compatibility layers, dual behavior paths, or "just in case" recovery branches unless the user explicitly asks for a migration or compatibility plan.
- When something fails, debug in this order: first ask whether the design/model is wrong, then whether the implementation violates the design, and only then whether an explicit domain validation branch is missing.
- Fix errors at the root cause. Do not add guard logic that merely hides an inconsistent state or papers over a broken contract.
- Tests must assert business behavior, runtime invariants, and public contract outcomes. Do not write tests that pass by asserting source-code shape, private helper structure, or implementation text unless the source shape is itself the generated business contract.

## Current Validation State

- TypeScript POC scaffold is present under `src/`.
- Customer-facing TypeScript SDK package is present under `sdk/client/`; SDK source is under `sdk/client/src/`, SDK tests are under `sdk/client/tests/`, and SDK public protocol source of truth is `sdk/client/public-protocol-spec-ch.md`.
- Scenario-based tests are under `tests/`; `pnpm test` compiles them to ignored `dist-tests/` output before running Node's test runner.
- Web PubSub integration tests read `tests/.env` for `WEBPUBSUB_ENDPOINT` and use `DefaultAzureCredential`; run `az login` before expecting those tests to exercise the real Azure service.
- Real Copilot SDK agent smoke tests read `tests/.env` for `RUN_REAL_COPILOT_AGENT_E2E`, `COPILOT_MODEL`, `COPILOT_PROVIDER_TYPE`, and `COPILOT_PROVIDER_BASE_URL`; provider auth uses Azure Identity/MSI, so run `az login` locally.
- Docker WorkerPool e2e tests require Docker Desktop, local `az login`, and `RUN_DOCKER_WORKERPOOL_E2E=1`; they build `containers/sidecar/Dockerfile`, mount the host Azure CLI profile, start a Docker sidecar through WorkerPool scale-out, and validate scale-in.
- Verified bootstrap command: `pnpm install`.
- Verified build command: `pnpm build`.
- Verified typecheck command: `pnpm typecheck`.
- Verified test command: `pnpm test`.
- Verified Docker WorkerPool auth probe command: `$env:RUN_DOCKER_WORKERPOOL_E2E='1'; node -e "require('fs').rmSync('dist-tests', { recursive: true, force: true })"; pnpm exec tsc -p tsconfig.test.json; node --test dist-tests/tests/workerpool/docker-sidecar-image.integration.test.js`.
- Verified Docker WorkerPool e2e command: `$env:RUN_DOCKER_WORKERPOOL_E2E='1'; node -e "require('fs').rmSync('dist-tests', { recursive: true, force: true })"; pnpm exec tsc -p tsconfig.test.json; node --test dist-tests/tests/workerpool/docker-workerpool.integration.test.js`.
- Verified SDK build command: `pnpm --dir sdk/client build`.
- Verified SDK typecheck command: `pnpm --dir sdk/client typecheck`.
- Verified SDK test command: `pnpm --dir sdk/client test`.
- Entrypoint commands are available: `pnpm start:central` starts the central HTTP server, and `pnpm start:sidecar` starts a standalone sidecar worker when `CENTRAL_URL` and `TENANT_ID` are set.