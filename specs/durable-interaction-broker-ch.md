# Durable Interaction Broker

状态：目标态设计

## 1. 设计决定

本设计只定义一种 off-agent interaction：Agent 在一个 turn 内等待外部 responder 回答 approval 或 client tool call，Central 将这项等待保存为 tenant-scoped durable `Interaction`，有权限的 client 通过任一被授权的 Session view 回答，Central 再把唯一结果交回实际执行该 turn 的 Session。

核心不变量：

- 一个 agent pending request 只对应一个 canonical `Interaction`。
- 执行 pending request 的 Session 是 `ownerSession`；普通 Session 和 Delegation-created Child Session 使用完全相同的 owner 流程。
- 单层 Delegation 中，Parent Session 只有一个可操作 projection，不拥有第二份 interaction 状态。
- 同一个 Central-generated `interactionId` 出现在 owner view 和 Parent view；agent adapter 的 pending `requestId` 只作为内部 `adapterRequestId`。
- 多个 view 可以提交响应，但只有第一次合法响应能完成 `open -> resolved`；后续响应得到 `already_resolved`，不能覆盖结果，也不能再次向 Worker 投递。
- response 先成为 durable resolution，再异步、幂等地投递给 owner Session 当前 request 所绑定的 Worker lease。

递归 Delegation、链式 Subsession、fan-out/fan-in 和 cross-tenant interaction projection 不属于本设计。Delegation-created Child Session 不能再发起 Delegation，因此一个 Interaction 最多只有 owner view 和一个直接 Parent view。

## 2. Interaction 边界

只有会挂起 agent turn、必须由 agent 进程之外的 responder 回答的请求才是 Interaction：

- `approval`：agent runtime 的 permission request。
- `tool_call`：没有 agent-local handler、需要 application client 兑现结果的 tool call。

Agent 自己执行的 built-in tool、MCP tool 和 handler-backed custom tool 仍是 observation。它们通过 `tool.started`、`tool.completed` 等 event 记录，不创建 Interaction。工具执行位置与 approval gate 是两条正交轴：agent-local tool 仍可能先产生 `approval` Interaction，但批准后工具仍由 agent 执行。

## 3. Durable Resource Model

`InteractionRecord` 是 canonical truth，不把每个 Session record 里的 `openInteractions` 数组当成独立真源：

```ts
interface InteractionRecord {
  interactionId: string;
  tenantId: string;
  kind: 'approval' | 'tool_call';
  request: unknown;

  ownerSessionId: string;
  ownerTurnSeq: number;
  adapterRequestId: string;
  requestLeaseId: string;

  views: Array<{
    sessionId: string;
    turnSeq: number;
    role: 'owner' | 'parent_projection';
    source?: {
      ownerSessionId: string;
      agentSpecId: string;
    };
  }>;

  state: 'open' | 'resolved' | 'interrupted';
  resolution?: {
    response: unknown;
    principalId: string;
    viaSessionId: string;
    resolvedAt: string;
  };
  interruption?: {
    reason: 'owner_lease_lost' | 'owner_turn_failed' | 'owner_session_terminal';
    interruptedAt: string;
  };

  delivery: {
    state: 'not_ready' | 'pending' | 'accepted' | 'abandoned';
    commandEventId?: string;
  };
  revision: number;
  createdAt: string;
  updatedAt: string;
}
```

字段语义：

- `interactionId` 由 Central 生成，在 tenant 内全局唯一，是 public protocol、SDK、event replay 和 response command 的关联键。
- `adapterRequestId` 是 owner agent adapter 的 pending RPC correlation，只能用于向 owner Worker 回包，不进入其他 Session 的 ID namespace。
- `requestLeaseId` 把 pending RPC 绑定到产生它的 Worker lease。旧 lease 的 response 不得投递到新 lease。
- `views` 固化可以观察和响应该 Interaction 的 Session。普通 Session 只有 owner view；Delegated Child 增加直接 Parent view。
- `resolution` 是第一次合法响应的 immutable 结果。
- `delivery` 独立于 resolution，使 Central crash、transport retry 或重复 command 不会造成二次决策或丢失已接受的响应。

Persistent storage 必须提供 Interaction 的 create、read、按 Session 查询 open records，以及 revision-based compare-and-set。进程内锁可以减少竞争，但不能代替 durable compare-and-set。

## 4. Owner Interaction Admission

Sidecar 通过 tenant inbox 上报 agent-originated request：

```ts
agent.interaction.requested {
  adapterRequestId,
  kind,
  request
}
```

`agent.interaction.requested` 是 sidecar-to-central ingress fact，不进入 client Session history。Central 在当前 Worker lease 校验通过后：

1. 生成新的 public `interactionId`。
2. 创建 owner `InteractionRecord`，保存 `adapterRequestId` 和 `requestLeaseId`。
3. 普通 Session 只创建 owner view。
4. 如果 owner 是 Delegation-created Child，读取 immutable `delegationBinding` 和 active `DelegationCall`，增加直接 Parent view；Parent view 的 `turnSeq` 使用 caller turn sequence。
5. 为每个 view append Central-authored `interaction.requested` session event。
6. 将各 view event publish 到对应 `session-events` channel。

对 SDK 可见的 `interaction.requested` 使用 Central public ID：

```ts
interface InteractionRequestedPayload {
  interactionId: string;
  kind: 'approval' | 'tool_call';
  request: unknown;
  source?: {
    kind: 'delegated_session';
    ownerSessionId: string;
    agentSpecId: string;
  };
}
```

Owner view 不带 `source`。Parent projection 带 `source`，让 UI 能说明真正请求 approval 或 tool result 的 Child Agent，而不暴露 `DelegationCall`、Worker 或 adapter correlation。

`InteractionManager` 使用确定性的 projection event identity，确保 Central 在 append event 与更新 projection 状态之间退出后，可以安全 reconcile，而不会在同一个 Session history 中制造重复 request。

## 5. Unified Response Workflow

所有 Session 都通过同一个 client command 响应：

```ts
interaction.respond.requested {
  sessionId,
  interactionId,
  decision?,
  scope?,
  result?
}
```

`InteractionManager.resolve(context, addressedSessionId, request)` 执行统一流程：

1. 读取 canonical `InteractionRecord`。
2. 确认 `addressedSessionId` 存在于 `views`。
3. 对 principal 执行 `session.interaction.respond` authorization；通过 Parent view 响应时，同时检查 owner Child 的 delegated interaction 权限。
4. 按 `kind` 校验 typed response：`approval` 需要 `decision` 和 scope；`tool_call` 需要 result。
5. 通过 revision compare-and-set 完成唯一的 `open -> resolved`。
6. 为所有 view append `interaction.responded`，其中 `interactionId` 相同，`turnSeq` 使用各 view 自己的 turn sequence。
7. 把 delivery 推进为 `pending`，由 reconciler 生成一次 owner Worker command。
8. 向发起 command 的 client private inbox 返回 `interaction.responded.ack`。

第一次合法响应返回：

```ts
{ interactionId, status: 'resolved' }
```

CAS 竞争失败且 canonical record 已 resolved 时返回：

```ts
{ interactionId, status: 'already_resolved' }
```

`already_resolved` 是正常幂等/并发结果。Central 不追加第二组 `interaction.responded`，不覆盖 canonical response，也不生成第二条 Worker command。SDK 不把它抛成异常；UI 收起 stale approval，并可提示该请求已在另一 Session view 中处理。

合法 envelope 但 authorization、ownership 或 typed response 校验失败时，Central 仍必须向 private inbox 返回：

```ts
{
  interactionId,
  status: 'rejected',
  error: { code, message }
}
```

SDK 将 `rejected` 映射成 typed error。Tenant inbox 不得只记录日志并让 SDK 等待 acknowledgement timeout。

## 6. Worker Delivery

Canonical resolution 不直接等价于已经恢复 agent turn。`InteractionManager` 持久化 resolution 和 `delivery.state = 'pending'` 后，由 reconciler 向 owner Session 的 `requestLeaseId` 投递：

```ts
session.interaction.response {
  sessionId: ownerSessionId,
  sessionLeaseId: requestLeaseId,
  interactionId,
  adapterRequestId,
  kind,
  response
}
```

Sidecar 必须：

- 拒绝不匹配当前 lease 的 command。
- 用 `adapterRequestId` 命中 agent runtime pending RPC。
- 按 `commandEventId` 幂等处理重复 command。
- pending RPC 成功 resolve 后上报 command accepted；Central 随后把 delivery 标记为 `accepted`。

Central restart、transport retry 或 accepted acknowledgement 丢失时，reconciler 可以重发同一个 `commandEventId`。重复投递不会再次执行 client tool，也不会再次改变 permission decision。

## 7. Approval Scope

`approval` response 支持：

- `scope: 'once'`：只批准当前 canonical Interaction。
- `scope: 'session'`：Sidecar 将结果映射为 agent runtime 的 approve-for-session decision，使 owner agent session 的 permission rule engine 记住规则。

无论 response 从 owner view 还是 Parent view 发出，`scope: 'session'` 永远只作用于 `ownerSessionId`。它不批准 Parent Session、不批准同一 Delegate 的其他 Child Session，也不成为 tenant-wide policy。

Standing rule 命中后，agent runtime 在 gate 内直接放行，不再 surface 新 Interaction。Central 保留带 scope 的 `interaction.responded` 和 audit record，但 SDK 或 Webclient 不维护本地 auto-approve rule。

## 8. Delegation Projection

单层 Delegation 中，Child 是普通 Session，也是 Interaction owner。Parent projection 只提供以下产品体验：

- Parent 用户无需切换到 Child 就能看到和回答 Child 的 approval 或 client tool request。
- Child 仍可通过普通 `SessionHandle` 直接观察和回答同一个 Interaction。
- 任一 view 首次响应后，两个 view 都收到 `interaction.responded` 并收敛关闭。
- Delegation result 仍沿普通路径返回：Child 完成 turn，Central 完成 `DelegationCall`，再把 tool result 返回 Parent。Parent 代答 Interaction 不会绕过 Child turn 或直接完成 `DelegationCall`。

Parent projection 不复制 canonical state，不创建新的 approval obligation，也不复用 Child adapter request ID 作为 Parent-local ID。

## 9. Disconnect, Pause, And Lease Loss

Client connection 不拥有 Interaction。Client 全部离线时，open Interaction 继续存在；后来 attach 的 client 从 session event history fold `interaction.requested` 和 `interaction.responded`，得到仍需回答的请求。

Pause 只在 turn boundary 完成。存在 open Interaction 时，该 turn 尚未到 boundary，正常 pause 不释放 owner lease；Session 保持等待 response，直到 Interaction resolved、turn terminal，或该执行被显式取消。

Worker lease loss 不能透明继承 pending RPC。`requestLeaseId` 失效后，仍 open 的 Interaction 进入 `interrupted`；已 resolved 但尚未 accepted 的 delivery 进入 `abandoned`。Central 为所有 view append terminal interaction event，并让原 turn 进入明确失败/恢复语义。Restart-with-context 后 agent 新产生的 permission 或 client tool request是新的 Interaction，必须获得新的 response；Central 不按 kind、turn 或 request 文本猜测它与旧请求相同，也不把旧 approval 自动应用到新执行。

只有 adapter 明确提供 true-continuation、并能恢复同一个 pending `adapterRequestId` 和 lease-fenced request identity 时，才可以在专门的恢复 contract 中继续原 delivery；该能力不属于本设计的 POC 路径。

## 10. Authorization And Audit

Central 在 admission、view projection、response 和 delivery 四个边界执行 tenant/session ownership 检查。V1 的 Delegation-created Child 与 Parent 具有同一 owner，因此 Parent owner 可以响应 projection；未来 participant/role policy 必须扩展显式 action，不得靠知道 `childSessionId` 获得权限。

每次成功 resolution 的 audit record 至少包含：

- tenant、interaction、kind 和 owner Session。
- addressed Session 与 view role。
- principal、decision/scope 或 tool result 摘要。
- resolved timestamp。
- delivery target lease 和最终 delivery outcome。

后到 response、authorization rejection、stale lease rejection 和 interrupted interaction 也进入 audit。敏感 request、tool result 和 credential 不直接写入摘要。

## 11. Component Ownership

| Component | 责任 |
| --- | --- |
| `InteractionManager` | tenant-scoped canonical record、admission、view projection、CAS resolution、event projection、delivery reconciliation、lease-loss terminalization |
| `AgentRuntimeEventController` | 校验/解析 `agent.interaction.requested` sidecar ingress，把 agent request 交给 `InteractionManager` |
| `ClientRuntimeEventController` | 校验 client envelope，把 response command 交给 `InteractionManager`，并保证 private ack |
| `DelegationRuntimeEventController` | 管理 Delegate tool、Call 和 result；不创建或关闭 interaction projection |
| `SessionManager` | Session command workflow；不保存第二套 interaction response 逻辑 |
| Sidecar | pending request bridge、lease fence、adapter response、command idempotency；不理解 Parent projection |
| SDK | typed session event、response command/ack；不维护 canonical state或跨 Session 去重 |
| Webclient | 展示 source、提交态和 ack；不自行同步 Parent/Child 状态 |

## 12. Public SDK Experience

App 在哪个 Session event 中看到 Interaction，就使用该 Session handle 回答：

```ts
const result = await session.respondToInteraction({
  interactionId: event.interactionId,
  decision: 'approved',
  scope: 'once'
});

// result.status: 'resolved' | 'already_resolved'
```

SDK 必须先注册 acknowledgement waiter，再 publish command。它不暴露 `adapterRequestId`、Worker lease、Parent route 或 pending RPC。

Webclient 在等待 ack 时保留 approval UI、禁用重复操作；`resolved` 和 `already_resolved` 都收起 UI，只有 `rejected` 或 transport failure 恢复操作并展示错误。Durable `interaction.responded` event 仍是各 Session replay/reconnect 的状态真源。

## 13. Validation

自动化 scenario tests 必须覆盖：

- 普通 Session approval 经过 canonical record、private ack 和 owner Worker delivery 后继续 turn。
- 同一 turn 的多个 client tool Interaction 按 Central public ID 独立 resolve。
- Client 离线期间 Interaction 保持 open，reconnect replay 后可回答。
- session-scoped approval 只在 owner agent session 建立 standing rule。
- Delegated Child request 同时出现在 Child 和直接 Parent，两个 event 使用同一 public ID。
- Parent 先回答会关闭两个 view，并只向 Child Worker 投递一次。
- Child 先回答会关闭两个 view，Parent stale click 得到 `already_resolved`。
- Parent/Child 并发提交相反 decision 时只有一个 CAS 胜者，另一个得到 `already_resolved`。
- Parent 自己的 Interaction 与 Child Interaction 不会因 adapter request ID 相同而碰撞。
- Central 在 resolution 后、projection 或 Worker publish 前重启，reconciler 能完成剩余 event projection和一次幂等 delivery。
- Worker lease loss terminalize 原 pending request，不把旧 response 应用到 restart-with-context 后的新请求。
- authorization rejection 返回 typed private ack，不退化成 SDK timeout。

产品验收通过真实 `samples/webclient`：在 Parent 与 Child 两个 Session view 中观察同一 approval，从其中任一 view 回答，确认另一 view 收敛、Child turn 继续、Parent 最终收到正常 Delegation result。

## 14. Non-goals

- 递归或链式 Delegation。
- 一个 Interaction 投影到多个祖先 Session。
- 多 approver quorum、approval delegation 和 timeout policy。
- Central-owned tenant-wide standing approval policy。
- Cross-tenant Interaction 或任意 Session-to-Session messaging。
- 对 restart-with-context 后的新 agent request 自动重放旧 approval。