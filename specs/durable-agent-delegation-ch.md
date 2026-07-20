# Durable Agent Delegation

状态：目标态设计

## 1. 设计决定

本设计只定义一种 agent communication：**Parent Agent调用一个Central注册的subagent tool，Central把该调用路由到另一个已注册AgentSpec的普通Child Session，并把Child的普通turn结果返回Parent。**

所有Agent都沿同一执行路径运行：

```text
AgentSpec -> Session -> Worker selection -> registered Worker -> Sidecar -> agent process
```

`copilot-poc`是Parent AgentSpec，匹配现有`poc-docker-copilot` WorkerPool。`copilot-foundry`是callee AgentSpec，匹配现有`foundry-copilot` WorkerPool。Delegation不知道也不关心Worker来自Docker还是Foundry。

本设计不要求callee Agent理解Delegation，不给callee注入特殊instructions，也不要求callee调用结果工具。Child Session像普通Session一样接收message、执行turn并产生`turn.completed`；Central把该普通turn结果作为DelegationCall结果返回Parent。

## 2. Agent可见模型

Parent看到一个普通subagent tool：

```json
{
  "name": "copilot_foundry",
  "description": "Ask the copilot-foundry subagent to handle the request. Use this when the user asks copilot-foundry to answer or when its hosted agent should perform the task.",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["message"],
    "properties": {
      "message": { "type": "string", "minLength": 1 }
    }
  }
}
```

Tool description是唯一的调用instruction：它告诉Parent什么时候使用该subagent。Parent AgentSpec本身保持通用instructions，不被改造成固定工作流Agent。

用户可以自然表达：

```text
请copilot-foundry回答：What is 2 + 2?
```

Parent调用`copilot_foundry({"message":"What is 2 + 2?"})`。该tool保持pending，直到Central收到Child普通turn的terminal结果。成功时tool result就是Child返回的message；失败时tool result明确描述失败，不由Parent猜测或补造答案。

## 3. Registered Delegate

Delegate是tenant-scoped注册资源，定义一个Agent可见subagent tool及其运行限制：

```json
{
  "id": "copilot-foundry",
  "toolName": "copilot_foundry",
  "description": "Ask the copilot-foundry subagent to handle the request. Use this when the user asks copilot-foundry to answer or when its hosted agent should perform the task.",
  "maxInputBytes": 8192,
  "maxResultBytes": 16384,
  "deadlineMs": 120000,
  "maxQueuedCalls": 2
}
```

AgentSpec只声明角色引用：

- `copilot-poc.delegateRefs.asCaller = ["copilot-foundry"]`
- `copilot-foundry.delegateRefs.asCallee = ["copilot-foundry"]`

每个Delegate必须解析到且只解析到一个callee AgentSpec。一个Delegate可以被多个caller AgentSpec引用。

Central在AgentSpec admission时把caller引用解析成immutable runtime tool definitions，并把它们固化进ResolvedAgentSpec。新增Delegate、修改description或改变callee Worker placement只需要Central重载配置；不需要重建Worker镜像。

## 4. Runtime Ownership

| Owner | 责任 |
| --- | --- |
| Central / TenantRuntime | Delegate registry、caller/callee binding、tool definition、Child Session创建/复用、Call FIFO、deadline、结果与失败 |
| Parent Agent | 根据tool description决定是否调用subagent，消费普通tool result |
| Child Agent | 像普通Agent一样处理message并完成turn；不知道Delegation存在 |
| Sidecar | 注入Central下发的任意runtime tool definition，转发通用tool request/response；不解析Delegate或hosting |
| HostPoolAdapter | 提供匹配AgentSpec selector的Worker；不参与Delegation语义 |

Container内的Sidecar代码必须保持通用。它不硬编码Delegate ID、callee AgentSpec ID、Foundry、`start/await/result`工具名或业务schema。

## 5. Durable Resource Model

`Delegation`是`(tenantId, parentSessionId, delegateId)`唯一的长期关系，拥有固定`childSessionId`。同一Parent重复调用同一Delegate时复用该Child Session；不同Parent永不共享Child Session。

Child Session进入普通Session catalog，并通过`parentSessionId`公开它与Parent Session的关联。该关联不改变Session的普通能力：client仍可直接`open/send/history/pause/resume/cancel`该Session；Central、SDK和UI不得因为它由Delegation创建而隐藏或限制它。

Client创建与Delegation创建必须进入同一个Session start workflow：持久化普通Session及`session.created`并推进到`queued`；统一reconciler根据该durable queued Session匹配Worker或驱动WorkerPool scale-out。Host调度在后台触发，不参与Session create acknowledgement的完成条件；协议不规定客户端对catalog projection与Host状态变化的观察顺序。Delegation只提供预分配的Child Session ID、Parent关联、resolved callee AgentSpec和首轮message；它不实现第二套create/queue/assign路径。

`DelegationCall`表示一次subagent tool调用，持有：

- `delegationCallId`
- Parent turn和tool request correlation
- FIFO `callSeq`
- input message和digest
- Child turn binding
- deadline
- terminal status
- result message或failure

一个Delegation最多一个active Call。Call完成后Child Session保持普通durable identity；队列为空时Central通过普通pause路径释放Worker，后续Call恢复同一个Child Session。

### 5.1 Interaction Projection

Child Session 的 approval 和 client tool request 遵循 [Durable Interaction Broker](durable-interaction-broker-ch.md)，不由 Delegation 另建一套 interaction 状态：

- Child 是 canonical Interaction 的 owner，和 client-created 普通 Session 进入同一个 admission、resolution 和 Worker delivery 流程。
- Central 为直接 Parent 增加一个可操作 projection；Child 与 Parent event 使用同一个 Central-generated public `interactionId`。
- Parent 或 Child 任一 view 的第一次合法响应完成唯一 canonical resolution，两个 view 随同一 resolution 收敛关闭，response 只投递给 Child Worker。
- Parent 代答 approval 或 client tool 不会直接完成 `DelegationCall`。Child 继续执行普通 turn，产生 terminal result 后再沿 Delegation result path 返回 Parent。
- `scope: session` 的 approval 只作用于 Child agent session，不作用于 Parent 或同一 Delegate 的其他 Child Session。

本设计只支持直接 Parent projection。Child Session不能继续发起 Delegation，不计算祖先链，也不把 Interaction 投影到多个层级。

## 6. Generic Runtime Tool Protocol

Central随`session.assign`下发ResolvedAgentSpec，其中包含runtime tool definitions。Sidecar把`name/description/inputSchema`直接传给Agent SDK。

Agent调用Central定义的tool时，Sidecar只发送通用事件：

```text
runtime.tool.requested {
  requestId,
  toolName,
  input
}
```

Central根据Parent Session内固化的tool binding解析Delegate，创建DelegationCall，并保持同一个tool request pending。Child完成普通turn后，Central发送：

```text
session.runtime.tool.response {
  requestId,
  result
}
```

Sidecar把result回填原Agent SDK pending tool call。协议中没有callee专用结果工具，也没有模型可选择的DelegationCall ID。

## 7. Result Semantics

Child的普通`turn.completed.result.message`就是Call的canonical result：

1. Central确认`sessionId + childTurnSeq`匹配active Call。
2. Central校验message非空且不超过Delegate的`maxResultBytes`。
3. Central原子持久化Call result并推进到`completed`。
4. Central用同一个Parent tool `requestId`返回message。
5. Child `turn.failed`或缺失message时，Call进入`failed`并返回明确失败。

Parent不得在Call失败后自行生成一个看似成功的subagent答案；最终用户回答必须来源于成功tool result。

## 8. Recovery与隔离

- Session是durable identity，Worker是可替换compute。
- Parent/Child拥有独立history、workspace、memory和lease。
- Parent只发送bounded message并接收bounded result，不读取Child history。
- Central restart从Delegation、Call、Session和event事实恢复，不重新选择Child Session。
- Worker loss遵循普通Session lease-loss语义；Call失败，不静默制造成功结果。
- Cross-tenant delegation、递归delegation、fan-out/fan-in和任意Session-to-Session messaging不属于本设计。

## 9. Validation

聚焦测试验证：

- Delegate toolName唯一、description非空、callee binding唯一。
- Central根据caller refs生成一个`copilot_foundry`runtime tool。
- 同一Parent/Delegate复用Child Session，不同Parent隔离。
- Calls严格FIFO且绑定唯一Child turn。
- Child普通turn message直接完成Call，无callee结果工具。
- Sidecar只转发Central定义的通用runtime tool request/response。
- 非runtime tool权限仍走普通人工approval路径。
- Child approval 同时投影到 Child 与直接 Parent，任一 view 响应后两个 view 收敛，且只向 Child Worker 投递一次。
- Child 直接响应后，Parent stale response 返回 `already_resolved`，不产生失败弹窗或第二次 Worker delivery。

产品验收使用真实`samples/webclient`手工Playwright：

1. 创建`copilot-poc` Session并等待本地Docker Worker running。
2. 输入“请copilot-foundry回答：What is 2 + 2?”。
3. 观察Parent调用`copilot_foundry`一个tool。
4. 观察现有`foundry-copilot` WorkerPool创建Child Worker并承载普通`copilot-foundry` Session。
5. 观察tool完成并由Parent返回Child的真实结果。
6. 确认Call durable status为`completed`，不存在`turn.failed`或伪造成功。

不新增代码化E2E测试文件。