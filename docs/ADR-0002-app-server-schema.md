# ADR-0002：Codex App Server 额度与线程契约（Wave 2 mock baseline）

状态：Accepted for local mock/static contract only  
日期：2026-09-01  
范围：`account/rateLimits/read`、`account/rateLimits/updated`、`thread/list`、`turn/interrupt`、`thread/resume`

## 1. 决策摘要

Wave 2 只实现一个注入式 `AppServerTransport` 边界和本地 fixture/mock。适配器没有默认 URL、`fetch`、账号登录、Tunnel 或生产 transport；真实 Codex App Server 不在本 ADR 的验收范围内。

当前实现可以：

- 只接收结构化的 `account/rateLimits/read` 或 `account/rateLimits/updated` 消息；将百分比转为整数 basis points，并保存 `primary`、可选 `secondary`、原始 `windowId`、`updatedAt`、`resetsAt`、`sampleHash` 和 `rawHash`。
- 在结构化样本新鲜且无冲突时，按 `primary.remainingBps <= 500` 触发 depleted/down-going guard；按 `primary >= 2000` 且 `secondary > 500`、样本新鲜、没有 exhausted 和 reset 后新样本，才给出 return-ready。
- 通过注入 transport 调用 `thread/list`、`turn/interrupt`、`thread/resume`；未知 in-flight、超时、原线程缺失、ID 不匹配或缺少 receipt 均返回结构化 fault/receipt，不补造 ID。
- drain 只在 `thread/list` 明确证明“全部当前账号可见 active threads”时继续，并要求注册差集、项目映射差集、每个 interrupt receipt、停止确认和完整 `handoff.md` 对账全部为空/通过。

## 2. 未验证事实

下列事实都仍是 `UNVERIFIED`，不可用本地 mock 结果宣称 G2/G3/G6 PASS：

| 事实 | 当前状态 | 需要的证据 |
|---|---|---|
| 真实 `account/rateLimits/read` 返回的字段、窗口 ID 和百分比语义 | UNVERIFIED | 用户批准的本机 capability probe 与脱敏原始 receipt |
| 真实 `account/rateLimits/updated` 通知的 method/params 形态、顺序和去重语义 | UNVERIFIED | 真实通知 receipt 与时间线 |
| `thread/list` 是否能完整表达当前账号在本机 App Server 可见的全部 active threads | UNVERIFIED | 真实全量枚举证据、可见范围证明和项目映射 |
| `turn/interrupt` 的最终一致性、receipt 字段和 timeout 后状态 | UNVERIFIED | 原 thread/turn 的真实 interrupt receipt 与重启对账 |
| `thread/resume` 是否存在、参数/返回值、原 thread continuity 和新 turn receipt | UNVERIFIED | 同一原始 thread 的真实 resume receipt；新建线程不算 |

## 3. 结构化输入基线

实现接受以下两类 operation 名称，其他自然语言、UI 文本、百分比字符串和页面 DOM 均不属于额度输入：

```json
{
  "method": "account/rateLimits/read",
  "result": {
    "rateLimits": {
      "primary": {
        "windowId": "provider-primary-id",
        "usedPercent": 95,
        "remainingPercent": 5,
        "updatedAt": "2026-09-01T00:00:00.000Z",
        "resetsAt": "2026-09-01T05:00:00.000Z"
      },
      "secondary": {
        "windowId": "provider-secondary-id",
        "usedPercent": 40,
        "remainingPercent": 60,
        "updatedAt": "2026-09-01T00:00:00.000Z",
        "resetsAt": "2026-09-07T00:00:00.000Z"
      }
    }
  }
}
```

`account/rateLimits/updated` 使用同一 `rateLimits` 结构，通常位于 `params`。实现只在同一窗口同时提供 used/remaining 且精确相加为 10000 bps 时接受；只提供一侧时计算另一侧并记录 `derivedUsed`/`derivedRemaining`。超过两位小数、越界、缺失窗口 ID、缺失/非法 `updatedAt`、百分比冲突或不能解析的 reset 时间进入 `unknown`/`conflict`。

规范化快照的关键字段：

```ts
type NormalizedQuotaSnapshot = {
  sampleId: string;
  sampledAt: string;
  updatedAt: string;
  primary: NormalizedRateLimitWindow | null;
  secondary: NormalizedRateLimitWindow | null;
  source: "app-server" | "fixture";
  rawHash: string;
  sampleHash: string;
  conflict: boolean;
  status: "fresh" | "unknown" | "conflict";
  reason: string;
  errors: string[];
  operation: "account/rateLimits/read" | "account/rateLimits/updated" | null;
};
```

`updatedAt` 必须来自结构化样本；本地当前时间只能由上层 gate 作为显式观测时间传入，不能单独宣布恢复。`resetsAt` 只用于检查提示，不能单独使 gate 恢复。给定上一份可信样本时，时间倒退和 primary/secondary window ID 无法映射会保持 `conflict`/`unknown`。

## 4. 线程与 receipt 基线

适配器只通过注入的：

```ts
interface AppServerTransport {
  request(method: AppServerMethod, params?: unknown, options?: AppServerRequestOptions): unknown | Promise<unknown>;
}
```

调用方法和主要约束如下：

| 方法 | mock 参数 | 成功必需事实 | 未知/失败处理 |
|---|---|---|---|
| `thread/list` | `{status:"active"}` | `threads` 集合 + `visibility:"complete"`/等价明确范围标记 | 范围不明为 `DRAIN_SCOPE_UNKNOWN`；对象无稳定 ID 为 `UNMAPPED_THREAD` |
| `turn/interrupt` | `{threadId,turnId}` | 返回 receipt ID，且 thread/turn（若返回）与请求一致 | timeout=`timeout`；可能已送达=`unknown_in_flight`；无 receipt/ID 冲突需对账 |
| `thread/resume` | `{threadId,checkpointRef}` | 原 thread ID 相同、receipt ID 和新 turn ID | 缺失原 thread、替代 thread、缺 receipt 或 timeout 均不得宣称回接 |

所有副作用要求非空幂等键。适配器保存真实请求 ID/receipt ID；任何缺失的 ID 只能返回 fault，绝不用 UUID 或本地生成 ID 补齐连续性。

## 5. Drain fence

`drainAllVisibleActiveThreads` 的 `HANDOFF_READY` 只有同时满足以下条件才可能为 true：

1. `thread/list` 明确证明完整可见范围；
2. `registeredThreadIds` 与 visible set 双向相等；传入的 `managedThreadIds` 不能是严格子集；
3. 项目映射与 visible set 双向相等，不允许缺失或多余映射；
4. 每个 visible thread 都有真实 interrupt receipt 且 `confirmed:true`；
5. `HandoffStore.writeHandoff` 对完整 source snapshot 做集合、数量、source hash 和 handoff hash 对账；
6. 任一故障、差集、未知范围或未确认停止都保持 `DRAINING`。

## 6. 与后续真实验收的边界

- 本 ADR 和 `tests/fixtures/app-server/**` 只证明 mock/static contract，可作为 Wave 2 unit/mock evidence。
- 不能把 fixture、静态 capability probe、DSH Admission Test 或一次自然语言响应当成 Codex 原 thread 的 `interrupt/resume` 证据。
- 真实探针必须单独取得用户批准，使用受控账号和脱敏 receipt；在真实字段、可见范围和 receipt 语义确认前，`CONTINUITY_QUOTA_GUARD_ENABLED`、自动 drain 和自动 resume 保持关闭。

## 7. 2026-09-02 真实形状补注（4B attempt 4，只读证据）

本文以上 mock 契约继续有效。真实 `thread/list`（`codex-cli 0.152.1`，只读全分页 416
条证据）实测：`result` 键为 `data`/`nextCursor`/`backwardsCursor`（非 `threads`）；
游标为 ISO-8601 时间戳字符串；条目 `status` 为结构化对象（实测全部
`{"type":"notLoaded"}`，非"运行中"判别）；`canAcceptDirectInput` 恒 null。适配器解析
按真实形状实现；"active/running 子集" 在取得 `thread/loaded/list` 受控授权证据前
保守返回 `DRAIN_SCOPE_UNKNOWN`。证据：`evidence/g4/app-server-thread-list-attempt4/`
（manifest、脱敏 transcript、`contract-facts.md`）。
