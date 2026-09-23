# 真实网页证据格式规范（Wave 6，plan §10.3.4）

本文件定义 G0-G7 真实网页验收的证据 bundle 格式与校验规则。`scripts/verify-real-web.mjs`
按本规范整理证据；**它只能整理与检查完整性，不能替代用户在网页中的观察取证与安全确认**
（plan §10.5）。`COLLECTED` 结论的含义是"bundle 结构完整"，永远不等于真实网页 PASS。

## 1. Bundle 位置与形态

根目录：`evidence/g1-g7/real-web/`（由验收人收集后放入）。两种形态二选一：

- `case-<X>.json` 单文件 bundle（X 为验收用例编号 A-L）；
- `case-<X>/bundle.json` 目录 bundle（目录内可附页面截图、transcript 等附件，
  bundle.json 通过相对路径引用）。

## 2. 必填字段

| 字段 | 含义 | 对应 plan §10.5 的对账项 |
|---|---|---|
| `case_id` | 验收用例编号，`A`-`L` | A-L 对抗性用例 |
| `observed_page_state` | 页面可见状态的文字/结构描述（验收人亲见） | 页面可见状态 |
| `tool_receipts` | MCP tool receipt 引用列表（envelope `continuity.v1`） | MCP tool receipt |
| `local_evidence_refs` | 本地 worker/文件/Git 证据引用 | 本地 worker/文件/Git 证据 |
| `event_refs` | `.ai-handoff/events.jsonl` 事件序列引用（seq 或 seq 区间） | events.jsonl |
| `next_state` | 状态机下一状态（`LifecycleState` 枚举） | 状态机下一状态 |
| `observed_at` | 观察时间戳（ISO-8601，可解析） | 时间戳 |

## 3. Terminal 用例的附加字段

`next_state === "WEB_TERMINAL"` 或 bundle 声明了 `terminal_reason` 时追加要求：

- `terminal_reason`：封闭枚举 `ALL_TASKS_COMPLETED` / `WEB_QUOTA_EXHAUSTED` /
  `HUMAN_STOP`（越出枚举 = bundle 无效）；
- `relay_epoch`：relay epoch 标识；
- `HUMAN_STOP` 追加 `stop_receipt_ref`：STOP_RELAY 指令或确认门肯定 receipt 的引用；
  普通人工回复不是停止指令（L）；
- `WEB_QUOTA_EXHAUSTED` 追加 `quota_receipt_ref`：额度 receipt 引用（账户级错误码
  或明确限额页面，含 `model`/`capturedAt`，有则 `resetAt`）；
  `post_recovery_resumed: false` 必须明确写入（K：额度恢复不续跑）。

## 4. 校验行为（verify-real-web.mjs）

- 每个缺失/空字段报 `missing:<field>`；
- 时间戳不可解析报 `invalid:observed_at`；
- terminal reason 越出封闭枚举、K 案例声明 `post_recovery_resumed: true`、
  缺 receipt 引用均判 `INCOMPLETE`；
- 报告含 A-L 全案例覆盖清单（缺失案例显式列出）；
- 退出码：0 = 所有已发现 bundle 均为 `COLLECTED`；1 = 存在 `INCOMPLETE`/`MALFORMED`
  或没有任何 bundle；2 = 参数/目录错误。

## 5. 证据红线（沿用 plan §10.2 / D-007 / D-012）

- screenshot/DOM/OCR/mock 不作为真实网页 PASS；
- worker/job 的 completed flag 不作为 artifact evidence；
- 网页文字不改变 executor/threshold，不进入 shell/patch；
- 普通人工消息、失联、固定时长、页面异常、timeout、普通 429 一律不得
  terminal；`WEB_QUOTA_EXHAUSTED` 对 relay epoch 不可逆吸收（K）；
- 证据先经 `redaction.ts` 脱敏（v2 规则）再落盘。
