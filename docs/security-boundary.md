# Security Boundary — Continuity Orchestrator 单一对外 App（Wave 4 基线）

> 2026-09-23：下方第 8 行及后续表格/正文为历史 relay 边界记录（包含已过时的 17-tool / 18-tool 和默认 mock 描述，保留为历史快照不作改动）。当前 relay 入口（`dist/src/main.js`）共有 20 个工具，其中新增 `continuity_task_register` 与 `continuity_drain`，并已接通生产适配器与跨重启持久化；工具数量由 `tests/unit/mcp-schema.test.ts` 固定。当前接线能力、证据等级与未闭合边界以 [Plus 模式说明 (2026-09-23)](plus-mode-2026-09-23.md) 及 [设计复审](design-review-2026-09-08.md) 为准，不从本地合同测试推定真实网页/账户闭环完成。

状态：CURRENT STATE 2026-09-05（基于 2026-09-03 ZCode 接力实现及后续只读复核）。本文描述当前代码真实实施的安全边界；
与设计文档冲突时以本文为准的"当前实施"事实为准，设计意图仍以《最佳融合设计方案.md》为准。

## CURRENT STATE 2026-09-05

本节是当前实施状态入口；Wave 6 增补仍作为历史实现记录保留。以下是本机代码和既有
证据可证明的边界，不把 mock/unit/dev 结果写成真实网页、Tunnel、App Server 或账号
能力 PASS。

| 能力 | 当前实施事实 | 证据等级/状态 |
|---|---|---|
| 单一 MCP App | `src/main.ts` 暴露 17 个 `continuity_*` 工具；stdio 启动已声明 `capabilities.tools` | LOCAL_CODE；dev Tunnel override 已列出 17 tools |
| webgpt-drive | `main.ts` 默认构造 `MockWebgptDriveTransport`；真实 `webgpt-drive` transport 尚未接线，`REAL_WEBGPT_DRIVE_CAPABILITIES` 仍不构成 production 能力 | MOCK/CONTRACT；真实探针 1 条消息 PASS，production wiring UNKNOWN |
| Codex App Server | adapter 是注入式 seam；真实 stdio `thread/list` attempt4 只读证据 PASS，但 active scope、quota、interrupt/resume 的生产 adapter 未接线 | REAL_READ_ONLY_ENUMERATION；生产控制/回接未验证 |
| worker/patch/quota | `main.ts` 未注入 real worker、patch backend 或 quota provider；对应路径 fail-closed | LOCAL_FAIL_CLOSED；非生产 PASS |
| Tunnel | dev override 验证 Continuity App 17 tools；冻结 profile 实际挂 `engineering-bridge` v1.4.0 13 tools；真实 discovery 缺 Read+Use runtime key | DEV_WIRING；REAL_TUNNEL_DISCOVERY BLOCKED |
| G3/4E/4F/G0-G7 | 全量 active drain、manifest/chunk/hash/accept 真实 handoff、interrupt/resume、账户级 web quota 与完整真实验收均未闭合 | UNKNOWN/BLOCKED |

**2026-09-05 A-C 增量**：Wave A 文档/台账 `COMPLETE`；Wave B 本地 adapter seams `PASS`；Wave C 本地 wiring `PASS`。独立复验：`typecheck=0`、`unit=150/150`、`integration:mock=38/38`、`security=9/9`、`restart=10/10`。以上全部仅为 `LOCAL_UNIT/LOCAL_MOCK`，不是 REAL_WEB、REAL_TUNNEL、REAL_APP_SERVER 或其他 real external PASS。下一门是 Wave D：提供 Tunnels Read+Use runtime key，执行只读 discovery，将结果回传用户确认后才允许 production mount；Wave E/F/G 仍为 `UNKNOWN/BLOCKED`。

网页接力的安全语义必须保持：这是长时无人值守执行，不是短时监督。Codex 额度耗尽
时，`handoff.md` 必须含该窗口的全部剩余待办；网页逐条执行直到全部任务完成、明确
账户级 `WEB_QUOTA_EXHAUSTED` 或明确停止指令/已确认人工确认门。阶段完成、Codex
额度恢复、普通人工回复、普通 429/超时/页面异常都不是回接条件。网页额度耗尽固定
进入 `WEB_TERMINAL`，Terminal 等 Codex 恢复；网页不能直接读本地路径，handoff 必须
经 `manifest → chunk → hash 对账 → accept`。

## 1. 对外入口：单一 App

- `src/mcp/server.ts` 的 `ContinuityMcpServer` 是唯一对外工具面：17 个 `continuity_*`
  高层工具（设计 §5.2 的 14 个 + 4C/4E 交接投递所需的 manifest/chunk/accept 3 个）。
- **child MCP 工具不暴露**：engineering-bridge / claude_orchestrator / codex-app-server
  只作为内部适配器存在，`listTools()` 永不列出它们。
- `src/main.ts` 把该 App 以**一个** stdio MCP Server 挂载（`@modelcontextprotocol/sdk`），
  默认全部 flag 关闭 → 所有工具返回 `FEATURE_DISABLED`，fail-closed。

## 2. 输入校验（src/mcp/schemas.ts）

- 所有工具输入是 **zod strict schema**：未知字段直接拒绝（`TOOL_INPUT_INVALID`），
  不静默忽略危险字段。
- 标识符（task_id/project_id/attempt_id/patch_task_id）拒绝路径分隔符、`..`、NUL；
  绝对路径、盘符、URL 形态的字符串在 `src/security/allowlist.ts` 的
  `resolveWorkspacePath` 中拒绝，解析结果必须落在已注册 workspace root 内。
- executor / worker_kind / action 全部枚举化：web 侧永远无法命名 `luna`，
  worker_kind 只能是 `claude | dsh | bridge-dsh`（内部再映射为显式 executor 路由，
  经 `routing/executor-policy` 校验：DSH 只能 fresh turn、Bridge 必须 executor:dsh）。
- `confirmation` 是 `z.literal`：`"APPLY"` / `"COMMIT"` 必须逐字节精确匹配，
  大小写、空白、自然语言变体一律 `TOOL_INPUT_INVALID`。
- 所有 mutation 工具要求 idempotency key（≥8 字符）；`web_session` 除 `read` 外
  均要求。同键同 payload 重放返回首次 receipt（标注 `idempotent replay` warning）；
  同键不同 payload 返回 `IDEMPOTENCY_KEY_REUSED`（设计 §6.4.2/3）。

## 3. 确认门（src/security/confirmations.ts）

- `BIND / AUTHORIZE / APPLY / COMMIT` 四种门；`APPLY`/`COMMIT` 由 patch apply/commit
  在同一请求内原子地 open+require+consume：门不可复用、不可重放（第二次 apply 报
  `PATCH_ALREADY_APPLIED`，且 gate 已被消费）。
- 补丁必须先 `validate` 得到结构化 `PASS` 才允许 apply；`INCOMPLETE`/`FAIL` 一律
  `PATCH_NOT_VALIDATED`。commit 必须在 apply 之后（`PATCH_NOT_APPLIED`），
  重复 commit 拒绝，`push/deploy` 无对应后端、按设计拒绝（envelope 中
  `push_deploy: "rejected_by_design"`）。

## 4. 权限与 Tunnel（src/security/allowlist.ts）

- Tunnel 权限模型只允许 `Read`、`Use`；任何 `Manage` 出现在权限解析中即
  `RED_FLAGGED_INPUT`（消息明确 Manage 永不进入运行配置）。
- workspace 必须显式注册（逻辑 ID → 绝对根路径）；未注册 workspace/attempt/task/
  patch id 的引用一律拒绝（`RED_FLAGGED_INPUT`），不存在"默认可见"。

## 5. 状态机与幂等（复用 Wave 1 领域层）

- 一切账本变更经 `TaskCoordinator`（每任务一个 `.ai-handoff/<taskId>/` 目录：
  state.json + events.jsonl + evidence/ + handoff.md/return.md），revision 冲突
  返回 `REVISION_CONFLICT`，状态只能沿主路径前进。
- `prepareHandoff`（src/workflow/handoff.ts）先校验完整快照（集合/数量/hash/收据）
  再落盘：校验失败时账本停留在原状态（无 DRAINING 脏状态）。
- 交接投递（manifest/chunk/accept）：manifest hash 覆盖 canonical 文档；chunk 读按
  chunk hash 校验（不符即 `HANDOFF_RECONCILIATION_FAILED`）；accept 需 manifest hash
  一致 + 全部 chunk receipt 覆盖 + 本地重验，之后才写 accept 收据与证据。

## 6. 证据（src/evidence/evidence-writer.ts）

- 证据只写入 `.ai-handoff/<taskId>/evidence/`，先经 `persistence/redaction`
  （敏感键值替换、超限截断到 maxEvidenceBytes），文件名即 evidence id；
  **append-only**：同 id 不同内容拒绝重写，同 id 同内容幂等返回原引用。
- 每条证据返回仓库相对路径 + SHA-256 + 截断标记，供 envelope `evidence_refs` 引用。

## 7. 网页面不可信（src/adapters/webgpt-drive.ts）

- 网页文本/页面状态永不解释为命令；send/read 只接受结构化 payload，返回结构化 receipt。
- **缺 receipt 即 fail-closed**：无上游 messageId 或 send/complete receipt →
  `WEB_CONTRACT_GAP/blocked`，不留成功假象；页面状态 unknown/loading/error →
  receipt 带 `blockedWaiting: true`，映射到 `BLOCKED_WAITING` 子状态，永不 terminal。
- **真实 webgpt-drive 传输尚未接入生产入口**：`src/main.ts` 默认使用
  `MockWebgptDriveTransport`；`REAL_WEBGPT_DRIVE_CAPABILITIES` 不能被解读成已接线的
  production transport。4C 专用页签探针确实观察到一条真实消息、`web_chat_id` 和
  权威 message IDs，但这是 REAL_WEB 取证，不是当前 App 的 production wiring PASS。
  账户级 web quota 未触发，不能产生 `WEB_QUOTA_EXHAUSTED`。
- mock transport 证据等级恒 `MOCK_PASS`；真实 transport/网页额度缺少生产接线或
  账户级 receipt 时保持 `UNKNOWN/BLOCKED`，不得混充。

## 8. 当前未接线（fail-closed 的诚实边界）

- quota provider：`main.ts` 未配置 → quota 系工具返回结构化错误，不猜测；网页账户级
  quota 未演练，普通 429/timeout/challenge/UI 变化只能是 `BLOCKED_WAITING`，不能
  生成 `WEB_QUOTA_EXHAUSTED`。
- webgpt-drive production transport：`main.ts` 仍默认 mock；真实 chat/message
  receipt 探针不等于运行时 adapter 已接线。
- Codex App Server production adapter：当前为注入式 seam；真实 `thread/list` 的
  attempt4 只证明 21 页/416 条/416 unique 的完整注册表读取，active set 仍
  `DRAIN_SCOPE_UNKNOWN`，quota、`turn/interrupt`、原 `thread/resume` 仍未接线。
- worker/patch 后端：未注入适配器 → `WORKER_BACKEND_UNAVAILABLE` /
  `PATCH_BACKEND_UNAVAILABLE`（retryable），不伪造 job/receipt。
- `continuity_resume_codex`：无 App Server resume 适配器 → 返回
  `RESUME_BACKEND_UNAVAILABLE` 并携带 original_thread_id；**绝不创建替代线程冒充回接**。
- `WEB_TERMINAL` 只能由封闭 terminal reason + 对应收据进入；`prepare_return` 在
  网页执行仍活跃且完成守卫未过时返回 `TERMINAL_GUARD_FAILED`。

## 9. 测试证据边界

- `npm run typecheck` 通过；`npm run test:unit` **102/102**；
  `npm run test:integration:mock` **30/30**；`npm run test:security` **9/9**；
  `npm run test:restart` **10/10**；`scripts/verify-restart.mjs` 演练
  **12 checks PASS**（含 lease renewal）。这些是 **LOCAL_UNIT/LOCAL_MOCK** 证据，
  不是生产 web、Tunnel、App Server、worker 或账号证据。
- 它们不是 G3/G4/G6/G7 的真实网页、Tunnel、App Server、账号证据；真实证据的取得顺序
  与停止门见《最佳融合落地执行方案.md》4B–4F 与 G0–G7 矩阵。

## 10. Wave 6 安全复核增补（2026-09-03，ZCode 接力）

### 10.1 脱敏复核（plan §10.3.1，`src/persistence/redaction.ts` v1→v2）

复核发现并修复两个真实缺陷，均已加回归测试（`tests/unit/persistence-idempotency.test.ts`）：

1. **`sk-` 误伤（严重，存在于 v1）**：值模式 `sk-[A-Za-z0-9_-]+` 会把任何含
   "sk-" 前缀的普通字符串当作 OpenAI 密钥——任务 ID `task-restart-1` 落盘
   state.json 时被改成 `ta[REDACTED]`，**直接损坏持久化状态**。v2 要求非词
   字符边界 + 真实密钥长度（`(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}`，
   `ghp_` 系列同样处理）。
2. **查询串凭证不脱敏**：API 错误/重定向 URL 中 `?token=`/`?key=`/`?code=`
   携带的凭证 v1 不处理。v2 增加查询串模式（保留非凭证部分以便排障）。

保留不变的既有取舍（有意为之，非遗漏）：
- 键名 `prompt`/`transcript` 整值打码——证据通过外部引用回溯，不在状态文件里存原文；
- over-redaction 优于泄漏；未改变键名规则，只收紧了值的误伤面。

`REDACTION_VERSION` 升为 `continuity.redaction.v2`（钉住断言同步更新）。
本次会话内无依赖 v1 哈希的持久化证据，跨版本重放冲突不存在。

### 10.2 Wave 6 新增防线

- `tests/unit/security.test.ts`（9 用例）：封闭工具注册表、strict schema 未知
  字段/注入字段拒绝、未注册 ID/遍历 ID/NUL 拒绝、任意路径/盘符/URL/穿越拒绝、
  精确确认门（zod literal 第一层 + `assertExactConfirmation` 第二层，消费一次
  不可重放）、旧 revision 拒绝、luna/bridge 默认 Codex/DSH 伪 resume 全链路
  不可达、网页注入文本只是数据不触发任何后端、flag 默认全关且 web 来源
  禁改 flag、resume 永不伪造。
- `tests/integration/restart-reconcile.test.ts`（5 用例）+ `scripts/verify-restart.mjs`：
  state/event 重放指纹一致、索引只从任务目录重建、receipt 三分支
  （已完成→重放 / 未执行→可执行 / 未知→对账，绝不盲重执）、租约过期恢复/续租
  不产生 terminal、损坏事件日志报 `MALFORMED_HANDOFF` 不静默修复。
- `scripts/verify-real-web.mjs` + `docs/real-web-evidence.md` +
  `tests/real-web/README.md`：真实网页证据 bundle 格式（A-L 封闭案例、terminal
  reason 封闭枚举、K 不续跑/L 停止 receipt 校验），整理器只查完整性、不判 PASS。
- `docs/ADR-0004-recovery-and-retention.md`（PROPOSED）：恢复/保留/并发/密钥
  12 项决策，[推荐默认] 与 [须用户决定] 分离。

### 10.3 工具清单精度

`src/main.ts` 的 `inputSchemaFor` 从"全部 string 属性"的粗略 schema 升级为
由权威 zod schema 派生的精确 JSON Schema（`zod-to-json-schema`，声明为直接
依赖），tools/list 对外合同与 dispatch 校验同源，杜绝漂移。
