# Specs 组织方式

本目录用于沉淀 Agent Runtime Sidecar 的目标态 specs。这里的文档应该像 Kubernetes API / controller 设计文档一样，以资源模型、接口、controller 和运行边界为核心组织，而不是按代码目录或实现进程堆叠说明。

## 组织原则

1. **先写 model，再写 component**
   先定义系统里的资源和事实：AgentSpec、Session、Worker、Event、Workspace/Snapshot、Policy/Audit。组件只是这些资源的 owner、controller、adapter 或 storage boundary。

2. **区分 resource、controller、adapter、process**
   - Resource 是 central service 里的可观察对象或 durable fact，例如 Session、Worker、Event。
   - Controller 是围绕 resource 做 reconcile 的逻辑，例如 worker selection、recovery、capacity scaling。
   - Adapter 是可替换的外部集成边界，例如 hosting adapter、storage adapter、sidecar agent adapter。
   - Process 是部署形态。一个进程可以包含多个 controller 或 adapter，但 spec 不应该用进程边界替代模型边界。

3. **借鉴 Kubernetes，但不照搬对象**
   Kubernetes 给我们的模式是 declarative spec、status、controller reconciliation、Node 注册、watch/list、resource version 和 event/status 分离。Agent Runtime Sidecar 的 durable object 是 Session，不是 pod。Worker 更接近 Node：它是被 sidecar 注册进 central service 的 compute resource。

4. **把可替换行为归属到 controller 或 adapter**
   不要笼统写“某模块可替换”。每份 spec 都应明确：某个可替换行为由哪个 controller 或 adapter 承担，默认行为是什么，替换接口是什么，哪些 runtime invariant 不允许替换。

5. **信息传递必须有 source of truth**
   Controller 可以通过 watch/subscribe 获得变化通知，但不能把短暂 notification 当作 truth。V1 的 truth 应来自 central service state、persistent storage、session event log、worker heartbeat/status 和 workspace snapshot metadata。

## 当前规格文件

| 文件 | 目的 |
| --- | --- |
| [agent-runtime-sidecar-overall-spec-ch.md](agent-runtime-sidecar-overall-spec-ch.md) | 面向架构会议的整体说明，解释产品边界、V1 主线、阶段顺序和关键讨论点。 |
| [runtime-resource-model-ch.md](runtime-resource-model-ch.md) | 定义 AgentSpec、Session、Worker、Event、Workspace/Snapshot、Policy/Audit 这些大类资源和可替换边界。 |
| [poc-runtime-workflow-spec-ch.md](poc-runtime-workflow-spec-ch.md) | 定义 POC 的最小 workflow：本地 file storage、Web PubSub transport、Docker Worker，并支持到 pause/resume。 |
| [poc-implementation-plan-ch.md](poc-implementation-plan-ch.md) | 把 POC workflow 拆成按顺序实现的 coding slices，并为每一片定义 scenario-based test。 |

## 建议的后续拆分

后续 spec 不应继续扩写 overall spec，而应按下面模型拆分：

| 规格类型 | 建议文件 | 内容边界 |
| --- | --- | --- |
| Resource model | `runtime-resource-model-ch.md` | 大类资源、truth、metadata/status、不可替换 invariant。 |
| Central service controllers | `central-session-service-controllers-ch.md` | session lifecycle、worker selection、recovery、capacity signal、controller 输入输出。 |
| Sidecar protocol | `sidecar-protocol-ch.md` | sidecar daemon 如何注册 Worker、接收 lease、上报 status、提交 snapshot。 |
| Event model | `event-model-ch.md` | event envelope、ordering、idempotency、replay、subscription。 |
| Workspace and snapshot | `workspace-snapshot-ch.md` | workspace state、snapshot metadata、restore boundary、storage adapter。 |
| Auth and audit | `auth-audit-ch.md` | principal、resource/action、enforcement point、audit record。 |
| SDK/API | `sdk-api-surface-ch.md` | client/backend/sidecar API 边界和稳定字段。 |
| Deployment | `deployment-topology-ch.md` | self-hosted dev mode、production cluster、hosting adapters、capacity scaling。 |

## Component Spec 模板

每个后续 component 或 controller spec 建议使用同一结构：

```markdown
# <Name> Spec

## 1. 这是什么

## 2. 为什么需要

## 3. Owned Resources / Facts

## 4. Inputs and Outputs

## 5. Default Controller / Adapter

## 6. Replaceability

## 7. Internal Modules

## 8. Failure and Recovery Semantics

## 9. Authorization and Audit

## 10. Validation

## 11. Non-goals
```

## 可替换行为归属

| 行为类别 | 归属 | 规则 |
| --- | --- | --- |
| 基本不替换的 runtime invariant | Resource schema / central service enforcement | Session identity、Session lifecycle 核心状态、Event envelope、Worker registration 最小字段、auth/audit enforcement points 是公共语义。可以演进版本，但不应让每个客户自定义。 |
| 策略可替换 | Worker selection controller、Recovery controller、Snapshot controller、Worker capacity scaler | 默认实现必须能跑通 V1；替换只能通过明确接口影响决策，不能绕过 session truth、event log、auth/audit。 |
| Adapter 可替换 | Hosting adapter、Workspace storage adapter、Sidecar agent adapter、Authorization hook、SDK transport | Adapter 可接不同底座或 agent，但必须遵守资源模型和 public contract。 |
| 暂不建模 | 无 controller 归属 | 独立 output resource、marketplace、full management UI、model provider gateway 可能以后需要，但不应进入 V1 资源模型。 |
