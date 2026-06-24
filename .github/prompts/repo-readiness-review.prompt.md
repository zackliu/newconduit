---
description: "Review whether the repo is ready for a complex Copilot/Codex design or coding task."
name: "Repo Readiness Review"
argument-hint: "task or area"
agent: "agent"
---
# Repo Readiness Review

Review repo readiness for:

`${input:task:Describe the upcoming design or code task}`

Use the `repo-onboarding` skill. Focus on what a coding agent needs before it can safely work.

Return:

```markdown
## Readiness Review
- Source-of-truth docs:
- Missing context:
- Build/test/lint status:
- Architecture risks:
- Required instructions or skills updates:
- Recommended first task:
```