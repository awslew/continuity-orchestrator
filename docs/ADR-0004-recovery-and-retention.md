# ADR-0004：恢复、保留与开放问题决策（Wave 6）

状态：**Accepted（2026-09-03，用户一次性确认"按照 ZCode 推荐和建议的来，确认且全部授权"）**。原 PROPOSED 阶段每项决策标注的 [推荐默认]/[须用户决定] 区分保留为决策依据记录；全部 [须用户决定] 项已按其 [推荐默认] 采纳（见 §4 决策记录）。事实待定型项（R-10/R-12）按推荐继续 fail-closed，等真实链路证据后回改本 ADR。
日期：2026-09-03（PROPOSED）；2026-09-03 同日升 Accepted
范围：崩溃/重启恢复、`.ai-handoff` 保留与 Git 跟踪、网页 Chat 保留、cursor 与 receipt 保留期、Windows 并发写、密钥与隐私
输入：`最佳融合设计方案.md` §14.2 尚待核实的开放问题；Wave 0-4 已落地实现；`evidence/g4/*` 资产事实

## 1. 决策摘要

本 ADR 把设计文档 §14.2 的开放问题转成可执行决策。凡需要真实资产/账号事实
（当前由 4C/4D 阻断）或涉及用户账号/密钥/隐私的项，一律 [须用户决定]；
纯本地工程语义项给出 [推荐默认] 并已在代码中按该默认实现或预留。

## 2. 逐项决策

### R-1 `.ai-handoff` 是否纳入各项目 Git 跟踪
**[须用户决定]**（涉及用户仓库的提交策略与隐私）。
[推荐默认]：`.ai-handoff/` 加入各项目 `.gitignore`（不跟踪），理由：state.json、
events.jsonl 与 evidence 含任务/对话元数据，属运维状态而非源码；handoff.md /
return.md 需要交给网页/Codex 时由 App 显式读取并经 Tunnel 交付，不依赖 Git。
若用户希望审计链入库，改为跟踪但排除 `evidence/` 大对象，需重新过隐私确认。

### R-2 中央索引（index-cache.json）的备份/清理周期
**[推荐默认]**：索引缓存永不作为事实源（`IndexCache.rebuild()` 已实现从任务
目录重建）；不备份，可随时删除重建。清理仅由用户手动触发；App 不自动删除
任何任务目录（plan §8.6/§9.6 回滚条款一致）。

### R-3 `.ai-handoff` 的 ACL 与隐私保留
**[推荐默认]**：文件以 0600 权限写入（`atomic-json.ts` 已默认）；事件与证据
写入前经 `redaction.ts` v2 脱敏（本 Wave 复核后修复了 `sk-` 误伤与查询串
凭证两个缺陷，见 `docs/security-boundary.md` §脱敏复核）。保留期：不自动清理；
[须用户决定] 用户如需周期归档/删除，提供保留天数后由脚本（非 App 运行时）
执行。

### R-4 长时间网页接力后原 Codex `thread_id` 的保留期限与 resume 前置
**[须用户决定]**（依赖 Codex 侧真实行为，4F 受控 interrupt/resume 实验后才能
钉死）。[推荐默认]：ledger 永久保留 `codex.threadId` 与 `original_thread_id`；
`continuity_resume_codex` 在拿到真实 receipt 前一律 `RESUME_BACKEND_UNAVAILABLE`
（已实现）。保留期限不主动过期。

### R-5 网页 Chat 的保留与 taskKey → web_chat_id 映射
**[须用户决定]**（依赖 4C 补齐与用户对 ChatGPT 会话管理的偏好）。
[推荐默认]：按 plan Wave 4 修正章顺序第 1 条，持久化 `taskKey → web_chat_id/url`
映射并在每次发送前核验目标仍匹配；不匹配 → fail-closed（BLOCKED_WAITING），
绝不静默换 Chat。多任务永不共用 Chat（D-012/Wave 5 边界）。

### R-6 cursor 与 receipt 的保留期
**[推荐默认]**：权威 cursor 是本地 ledger 的 `eventSeq`/`stateRevision`
（Wave 4 修正章顺序第 3 条），随 ledger 保存、不过期；send/complete/accept
receipt 作为 evidence 引用永久保留（append-only）。网页侧不产生权威 cursor。

### R-7 多任务同仓库并发写（Windows 文件锁 / Git index 锁 / 用户手工编辑）
**[推荐默认]**：每任务一个 `.ai-handoff/<taskId>/` 目录 + revision 乐观并发
（`REVISION_CONFLICT`）+ 写入走同目录临时文件原子 rename（`atomic-json.ts`）。
同仓库不同任务的写入互不交叉；App 不触碰 Git index（受控 patch 的 apply/commit
由注入后端执行并出 receipt）。与用户手工编辑冲突时：检测到 `REVISION_CONFLICT`
或 hash 不符即 fail-closed，不以 App 侧状态覆盖用户改动。

### R-8 Secure MCP Tunnel 的 key 轮换、开机守护与 workspace 关联
**[须用户决定]**（涉及用户 Cloudflare 账号与生产 key；plan §10.2 禁止未经用户
同意轮换 key/改变 Tunnel 关联）。[推荐默认]：key 只存本机配置，永不出现在
聊天/证据中；隧道权限固定 Read+Use（Manage 永不进入运行时配置，
`allowlist.parseTunnelPermissions` 已实现拒绝）；开机守护方式（任务计划程序 /
服务）等 4D 真实链路打通后由用户选择。

### R-9 网页 Chat 自身限额的可靠检测
**[须用户决定]**（当前资产证据：网页账户额度 ABSENT，`evidence/g4/
4c-contract-gap-verification/`）。[推荐默认]：自动回接保持关闭；额度 receipt
只接受账户级错误码或明确限额页面（Wave 4 修正章顺序第 4 条）；普通
429/timeout/challenge/UI 变化 → `BLOCKED_WAITING`；若最终只能人工确认，
`WEB_QUOTA_EXHAUSTED` 的判定进入用户确认门，不得由 App 自行宣布。

### R-10 `account/rateLimits/updated` 的形态与 window 字段稳定性
**[须用户决定→转为 4F/真实链路验证]**：quota-gate 已实现双形态容错（通知/方法
均可注入），但"当前 App Server 版本实际是哪种"须在真实链路（4F 前置确认后的
受控实验）中钉死；本 ADR 不预设。

### R-11 DSH fresh turn 的最小 checkpoint 集合与网页文本注入隔离
**[推荐默认]**：fresh turn 携带的最小集合 = `taskId` + `relayEpoch` +
`checkpointRef`（本地 ledger 事件）+ 结构化 instruction_ref（`kind/ref`）；
**网页原文永不进入新 turn**——下行指令只引用本地证据引用（`instructionRefSchema`
已把原始文本挡在边界外，security.test.ts 已覆盖注入用例）。

### R-12 `claude_orchestrator` resume 标识映射与重启后可查性
**[须用户决定→转为 G3 真实链路验证]**：统一 `WorkerAttempt` 已预留
`realSessionRef`（jobId/sessionId/threadId）与 `freshTurnRef`（明确 null 语义）
字段；真实映射在 claude_orchestrator 资产路径钉死后补齐（Wave 0 清单当前
`HEALTH_PRESENT_ASSET_PATH_UNKNOWN`）。

## 3. 影响与执行

- 各决策项的语义以 §2 原文为准；本节与 §4 只记录"何时、由谁、以何授权"定为现行行为。
- 事实待定型项（R-10/R-12）按推荐继续 fail-closed：不预设真实形态、不实验
  interrupt/resume（4F 前置确认仍有效，实验只对非当前测试任务）；真实事实钉死后回改本 ADR。
- 变更任一决策须回改本 ADR 并记录新授权来源。

## 4. 决策记录（2026-09-03）

- **授权来源**：用户在本轮接力对话中明确指示"按照你推荐和建议的来，我确认且
  全部授权，你能完成多少就完成多少，尽量留给 codex 最少的工作量"。
- **逐项结果**：
  - R-1 → 采纳推荐：`.ai-handoff/` 加入各项目 `.gitignore`，不跟踪（验收链
    证据经 App/Tunnel 显式交付，不依赖 Git）。
  - R-2 → [推荐默认] 原样生效：索引缓存永非事实源，不备份，不自动清理。
  - R-3 → 采纳推荐：0600 + 写前脱敏；**不自动清理**；用户如需周期归档/删除
    再提供保留天数，由脚本（非 App 运行时）执行。
  - R-4 → 采纳推荐：ledger 永久保留 `codex.threadId`/`original_thread_id`；
    resume 在拿到真实 receipt 前一律 `RESUME_BACKEND_UNAVAILABLE`；不主动过期。
  - R-5 → 采纳推荐：持久化 `taskKey → web_chat_id/url` 映射并每次发送前核验；
    不匹配 fail-closed（BLOCKED_WAITING），绝不静默换 Chat。落地载体见 4C 补齐
    （A 类 `web_chat_id` 暴露 + Continuity 侧发送前核验）。
  - R-6 → [推荐默认] 原样生效：权威 cursor = 本地 ledger `eventSeq`/`stateRevision`；
    receipt 作为 evidence 引用永久保留（append-only）。
  - R-7 → [推荐默认] 原样生效：每任务独立目录 + revision 乐观并发 + 原子写；
    不触碰 Git index；冲突即 fail-closed。
  - R-8 → 采纳推荐：key 只存本机配置永不出现在聊天/证据；隧道权限固定
    Read+Use（Manage 永不进运行时配置）；**不轮换 key**；开机守护方式待 4D
    真实链路打通后由用户选择（该子项保持开放）。
  - R-9 → 采纳推荐：自动回接关闭；额度 receipt 只接受账户级错误码或明确限额
    页面；普通 429/timeout/challenge/UI → `BLOCKED_WAITING`；`WEB_QUOTA_EXHAUSTED`
    最终判定进用户确认门。
  - R-10 → 事实待定型（原 [须用户决定→转为 4F/真实链路验证]）：quota-gate 双
    形态容错保持，"实际是哪种"等 4F 受控实验钉死，不预设。
  - R-11 → [推荐默认] 原样生效：fresh turn 最小集合 + 网页原文永不进新 turn。
  - R-12 → 事实待定型（原 [须用户决定→转为 G3 真实链路验证]）：`realSessionRef`/
    `freshTurnRef` 字段保留，映射等 claude_orchestrator 资产路径钉死后补齐。
- **升级为 Accepted 的边界**：本 ADR 的 Accepted 不等于 4C/4D/4E/4F 完成——
  它只表示 §14.2 的"工程语义类"开放问题已有既定默认；"资产事实类"问题仍由
  4C/4D/4E/4F 的证据闭环回答。
