---
name: repo-onboarding
description: "Use when onboarding to a complex repo, starting a large design or code change, building a repo map, discovering architecture, finding build/test commands, or reducing exploration cost for Copilot/Codex."
argument-hint: "task or area to map"
---
# Repo Onboarding

Use this skill before large changes, unfamiliar areas, migrations, cross-module refactors, or any task where the repo shape is not yet clear.

## Procedure

1. Clarify the task boundary: feature, bug, design question, docs-only change, or implementation change.
2. Inventory the repository:
   - Root files and directories.
   - README, design docs, ADRs, CONTRIBUTING, AGENTS, instructions, skills, prompts, agents.
   - Package manifests, project files, build scripts, CI workflows, test configs, generated-code configs.
   - Existing source, tests, examples, schemas, migrations, and deployment files.
3. Identify sources of truth and stale material. Prefer docs that are newest, most specific, and referenced by current agent instructions.
4. Map architecture boundaries:
   - Components and responsibilities.
   - Public contracts and wire formats.
   - Storage boundaries.
   - Auth, audit, tenant, and deployment boundaries.
5. Build a validation matrix:
   - Bootstrap command.
   - Build command.
   - Unit/integration/e2e test commands.
   - Lint/format/schema generation commands.
   - Commands that are missing, unverified, slow, flaky, or unsafe.
6. Produce a concise repo context brief before editing.

## Current Repo Notes

- The repo is currently documentation-only.
- The current product boundary lives in `agent-runtime-sidecar-brief-ch.md` and `agent-runtime-sidecar-brief-en.md`.
- The longer proposal files are useful background but may be broader than the current MVP direction.
- There are no verified build or test commands yet.

## Output Format

Return:

```markdown
## Repo Context Brief
- Task boundary:
- Source-of-truth files:
- Relevant architecture areas:
- Existing validation commands:
- Missing validation commands:
- Risks and unknowns:
- Recommended first edit slice:
```