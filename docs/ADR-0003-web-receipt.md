# ADR-0003: Web Receipt 的权威性与对账规则

状态：Accepted（2026-09-03，Wave 5，owner-w5；依据 Wave 4 合同证据与
`evidence/g4/4c-contract-gap-verification/contract-pass-verification.md`）

## 背景

网页（ChatGPT）侧产出的 receipt 种类多、来源杂（页面 URL、DOM 属性、
`/backend-api` 响应、桌面 HTTP API 回显），必须钉死"哪些是权威事实、哪些只是
证据引用、丢失后如何对账"，否则自动唤醒/多任务会在未知状态上叠加副作用。

## 决策

1. **权威 cursor 是本地 ledger 的 `eventSeq`/`stateRevision`**（与 ADR-0004 R-6
   一致）。网页侧不产出 cursor；web read receipt 的 `cursor` 字段仅是透传证据
   （fixture `tests/fixtures/web-receipts/web-read-receipt.json` 固定 `null`）。
2. **web message receipt 的权威 id 是上游返回的真实 message id**（B 类探测已
   证实可得：`POST /backend-api/f/conversation` mapping 节点）。DOM
   `[data-message-id]` 只作旁证，永不作为权威来源写入 ledger。
3. **`clientOperationId` 由调用方生成、原样回显**；幂等语义留在 Continuity 侧
   （`IdempotencyRegistry` + adapter 按 key 回放）。重复唤醒返回原 receipt，
   不产生第二条消息。
4. **taskKey → web_chat_id 映射持久化于 ledger，并在每次发送前后核验**
   （ADR-0004 R-5）。失配/不可验 → `WEB_CHAT_ID_MISMATCH`/`WEB_CHAT_ID_UNVERIFIED`，
   无 receipt 残留，任务停靠 `BLOCKED_WAITING`；聊天永不静默切换。
5. **receipt 三分支对账**（`src/workflow/reconcile.ts`）：
   `completed` → 复用 receipt；`in_flight`（未知结局）→ 停同类副作用、停靠
   `BLOCKED_WAITING`，绝不盲目新建消息/worker/resume；`missing`（确证未派发）→
   仅允许**同一幂等键**重试。无法键控的类型（`web_read`）按未知处理。
6. **quota 纪律**（ADR-0004 R-9）：`quota !== "none"` 一律 `blockedWaiting`；
   `account_limit` 只停靠并记 fault，terminal `WEB_QUOTA_EXHAUSTED` 永不由
   App 自宣布（用户确认门）。
7. **web terminal 吸收性**：进入 `WEB_TERMINAL` 后，额度恢复只改数据不回滚
   状态（`observeQuotaRecovery` 保持 terminal 与 reason 不变）。

## 后果

- 自动唤醒（`src/web/auto-wakeup.ts`）只发送预生成结构化消息，键由本地 cursor
  派生；页面状态不确定即停。
- 多任务（`src/web/multi-task.ts`）以 task/project/chat 为最小隔离单元，
  project 写锁串行同项目变更；跨任务引用直接拒绝。
- `codex-chatgpt-web` fallback 只在显式 flag 下选择；失败即关闭 flag 并冻结
  非终态，绝不第二个 App 并挂。
- 本 ADR 仅约束 mock/合同层语义；真实网页验收按 Wave 6 观察取证流程执行，
  mock PASS 永不冒充真实 PASS。
