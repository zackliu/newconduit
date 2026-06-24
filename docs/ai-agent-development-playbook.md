# AI Agent Development Playbook

本文档总结目前用高级模型、Copilot、Codex 或其他 coding agent 管理复杂 repo 时最有用的实践，并把它们落到本仓库的自定义结构里。

## 1. 分层定制，而不是一份超长提示词

复杂 repo 的最佳结构是分层：

1. 根级 `AGENTS.md` 放少量永远适用的规则。
2. `.github/instructions/*.instructions.md` 放按文件或任务触发的规则。
3. `.github/skills/*/SKILL.md` 放可重复、多步骤、按需加载的工作流。
4. `.github/prompts/*.prompt.md` 放单次任务模板。
5. `.github/agents/*.agent.md` 放需要隔离上下文或限制工具的专门角色。

这样做的好处是上下文更干净，模型不会每次都背完整手册；但遇到复杂设计、实现或审查时，又能加载对应能力。

## 2. Copilot 和 Codex 的共同入口

本仓库选择根级 `AGENTS.md` 作为 always-on 指令入口，而不是同时维护 `AGENTS.md` 和 `.github/copilot-instructions.md`。原因是：

1. Copilot 在 VS Code 和 GitHub 场景中支持 agent instructions。
2. Codex 和其他 coding agents 通常会读取 `AGENTS.md`。
3. 同时维护多个 always-on 文件容易出现规则冲突和漂移。

如果未来某个平台必须依赖 `.github/copilot-instructions.md`，再决定是否迁移；不要默认双写。

## 3. 复杂 repo 工作流

每个大任务按四步走：

1. **Map**：先盘点相关目录、文档、构建脚本、测试、CI、架构边界和既有约定。
2. **Decide**：把问题拆成机制原语、备选方案、取舍、失败模式和验证标准。
3. **Slice**：把实现拆成最小可审查阶段，每个阶段有明确契约、测试和回滚点。
4. **Validate**：运行最小必要验证，并把新发现的命令或坑写回 repo 指令或文档。

对应技能：

- `repo-onboarding`：用于 map。
- `agent-runtime-domain`：用于领域边界和第一性判断。
- `product-design-review`：用于 decide。
- `implementation-planning`：用于 slice 和 validate。
- `spec-consistency`：用于文档同步和中英文一致性。

## 4. 实现和测试原则

后续实现阶段默认采用 clean design，不默认背兼容包袱：

- 不写 fallback code。
- 不写 compatibility shim、legacy compatibility layer 或双路径兼容实现。
- 开发过程中不默认考虑 backward compatibility；只有用户明确要求 migration 或 compatibility plan 时才处理兼容。
- 出错时先判断 design/model 是否本身不合理，再判断 implementation 是否违反设计，最后才判断是否确实缺一个显式 domain validation。
- 修问题要修根因，不用额外 guard 把不一致状态藏起来。
- 测试必须依赖 business logic、public contract 和用户可见行为，而不是 source code 形状。
- 好测试应该验证 session lifecycle、routing decision、authorization result、recovery semantics、event persistence、artifact access 或 SDK contract。
- 不写只检查私有 helper、源码片段、函数调用顺序或实现文本的测试，除非源码形状本身就是生成出来的业务 contract。

## 5. 高级模型使用原则

- 把高级 reasoning 模型留给跨模块设计、复杂 bug、API contract、security model、migration plan 和大型 review。
- 普通机械改动可以用更便宜模型，但必须有验证命令和 diff review。
- 大上下文任务不要让主对话独自读完全部 repo；优先用只读 subagent 或专门 custom agent 做 repo map、风险扫描、架构 review。
- 不要把“让模型多读一点”当作唯一策略。更好的做法是维护 repo map、contracts、ADR、validation matrix 和 skills。

## 6. 指令写法

有效的指令应该：

- 短、具体、可执行。
- 解释非显然规则背后的原因。
- 包含触发词，让 agent 能按需发现。
- 链接源文档，而不是复制整段背景。
- 避免和 linters、formatters、CI 已经强制的规则重复。

无效的指令通常是：

- 太宽泛，例如“写高质量代码”。
- 太长，导致每次都占用上下文。
- 把多个问题混在一个文件里。
- 没有记录验证命令，导致 agent 反复试错。

## 7. 本仓库的初始改造

本仓库现在是文档优先、代码尚未落地的产品设计 repo。因此初始自定义重点是：

- 固化 Agent Runtime Sidecar 的产品不变量。
- 建立复杂设计审查流程。
- 建立未来代码实现的分阶段流程。
- 建立中英文 proposal 一致性流程。
- 为以后真正代码化 central service、sidecar、storage、SDK、protocol、auth/audit 时留下清晰入口。

当 repo 进入实现阶段，应第一时间补充：

1. 目录结构说明。
2. bootstrap/build/test/lint/run 命令。
3. API/schema 生成命令。
4. 本地开发和 production cluster 的验证路径。
5. CI 和 release 检查。