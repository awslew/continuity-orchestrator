# AGENTS.md

面向在本仓库工作的 coding agent。只记录**读代码不容易推出来**的约束；能靠 `ls` / `package.json` 一眼看到的东西不在这里重复。

## 这个项目是什么

一组把**本机被显式共享的项目**暴露给 MCP 客户端的 server 入口，外加一条实验性的 Codex 额度接力链路。三个入口互不依赖：

| 入口 | 源码 | 工具数 | 说明 |
| --- | --- | --- | --- |
| 只读入口 | `src/project-reader/mcp.ts` | 4 | 只读；**不加载**接力状态机 |
| Pro 入口 | `src/project-reader/pro.ts` | 25（本机全开） | 只读 + 连续编辑 + 自动开发 + 动态路径 |
| 接力入口 | `src/main.ts` | 20 | 实验性；装载 domain/workflow/persistence 全链路 |

## 核心机制（不读源码看不出来的部分）

- **证据分级是产品的核心约束，不是文案**。仓库里所有接力相关的测试通过都只算 **Local Contract Evidence（本地合同证据）**。它**不等于**真实网页、Tunnel、App Server、Bridge、真实账户或 worker 的端到端证据。G3/G4/G6/G7 在拿到各自的真实回执前必须保持 `未验证`。任何把本地测试结果表述成“真实网页已通过”的说法都是错的。
- **`REAL_WEBGPT_DRIVE_CAPABILITIES` 四项全 `false` 是刻意的**，且有单元测试锁住。它不是“还没填”，是安全决定。生产环境默认不开放未验证的真实 web 传输。
- **Gate D-MOUNT 未执行**：把生产 Tunnel profile 切到 Continuity App 是**待用户明确确认才可执行**的动作。agent 不得代为执行或宣称已验证。
- **两个模块刻意未挂载，不要“顺手接上”**：
  - `src/web/auto-wakeup.ts` —— 进程内没有调度宿主（stdio MCP 服务里 `setInterval` 计数为 0），其 payload 格式会被真实传输拒绝，且内部引用类型在 MCP schema 边界不可达。
  - `src/web/multi-task.ts` —— 纯内存隔离注册表，跨重启无法恢复任务映射，项目锁也没做持久化。
- **`handoff.md` 是接力状态的唯一真相来源**。它的完整 `remaining_work` 集合按**数量 + 任务 ID + 条目内容 + 哈希**四重校验。sidecar 不能修补缺失或不完整的 Markdown handoff —— 不要试图绕过。
- **终态是封闭集合**，只有三个：`ALL_TASKS_COMPLETED`、`WEB_QUOTA_EXHAUSTED`、`HUMAN_STOP`。阶段完成、空 ready 队列、错误、超时、Codex 恢复、或普通人类消息**都不是**终态。web-quota 终态对其 `relayEpoch` 是**吸收态**：恢复只作为数据记录，不能重新开始 web 执行。
- **接力生命周期**：`CODEX_ACTIVE -> DRAINING -> HANDOFF_READY -> WEB_UNATTENDED_EXECUTING -> WEB_TERMINAL -> RETURN_READY -> CODEX_RESUMED`；`WEB_UNATTENDED_EXECUTING` 有 `EXECUTING` / `RETRYING` / `BLOCKED_WAITING` 三个子态。
- **默认 dry-run**。生产接力动作由环境变量门控（`CONTINUITY_AUTO_DRAIN_ENABLED`、`CONTINUITY_RETURN_TO_CODEX_ENABLED` 等）。改代码时**不要**把这些默认值翻成开启。
- **构建产物在 `dist/`，测试跑的是编译后的 `.js`**。所以所有 `test:*` 脚本都先跑 `build`（`test:pro` 除外，它显式 `npm run build &&`）。只改了 `.ts` 不 build 就跑 `node --test dist/...` 会测到旧代码。

## 常用命令（均已在本仓库 `package.json` 核实）

```powershell
npm ci --ignore-scripts   # 安装；不需要 package 生命周期脚本
npm run build             # tsc -p tsconfig.json
npm run typecheck         # tsc --noEmit
npm run reader:check      # scripts/check-project-reader.mjs
npm run reader:stdio      # dist/src/project-reader/mcp.js（4 个只读工具）
npm run pro:stdio         # dist/src/project-reader/pro.js
npm run pro:setup         # scripts/setup-pro-project.mjs
npm start                 # scripts/start-mode.mjs
npm run test:reader       # build + 只读入口单测/集成
npm run test:unit         # build + dist/tests/unit/**/*.test.js
npm run test:integration:mock  # build + dist/tests/integration/**/*.test.js
npm run test:pro          # build + 12 个 Pro 测试文件
npm run test:security     # build + dist/tests/unit/security.test.js
npm run test:acceptance   # build + dist/tests/acceptance/real-project.test.js
npm run test:restart      # build + 重启对账
```

改完 `.ts` 的最小验证路径：`npm run typecheck` → `npm run test:unit`。碰到 Pro 或编辑链路再跑 `npm run test:pro`。

## 改动纪律

- **改规则/契约先改 `src/domain/` 与 `src/workflow/`，再往上改入口**。入口（`main.ts` / `pro.ts` / `mcp.ts`）应当只做装配与 schema 校验。
- **保持只读入口真的是只读**。`src/project-reader/mcp.ts` 只暴露 4 个读取类工具；不要往里加写入、执行或网络工具。
- **测试必须用临时目录**，不得写用户仓库账本或用户项目状态。这是仓库明示的行为契约。
- **改动工具数量、入口路径或生命周期状态时，同步更新 `README.md` 的入口表格与 `llms.txt`**。工具数是可被外部引用的公开事实。
- **README 里有一段已经过期的描述**：它写着“本目录尚未建立独立 Git 仓库”，但仓库实际已有 `origin`（`awslew/continuity-orchestrator`）且位于 `main` 分支。另有一段说“开源前应选定许可证”，而 `LICENSE` 已是 MIT。**不要凭这两句去改仓库结构或新建许可证**；如需修正，只改文案并明确告知用户。
- **不要把本机项目配置或凭据提交进版本库**：`config/*.local.json`、账本、`evidence/`、浏览器资料都不是发布产物。发布必须从干净的源码导出，**不要发布整个父工作区**。
- 旁边的 `engineering-bridge` 是独立的第三方 MIT 项目，不要把它当作本仓库的内部模块改。

## 模块速览

| 路径 | 职责 |
| --- | --- |
| `src/main.ts` | 接力入口：20 个工具，装配 domain / workflow / persistence / adapters |
| `src/project-reader/mcp.ts` | 只读入口：`continuity_projects_list` / `_project_files` / `_project_read` / `_project_search` |
| `src/project-reader/pro.ts` | Pro 入口：基础 12 + 编辑 5 + 自动开发 3 + 动态路径 5 |
| `src/project-reader/local-projects.ts` | 动态路径（`local_access`）项目解析，免逐项目登记 |
| `src/project-reader/editor.ts` / `snapshot.ts` | 连续编辑与 Git 快照 |
| `src/project-reader/runner.ts` / `runner-worker.ts` | 命令/测试执行与受监督 worker |
| `src/project-reader/bounded.ts` / `encoding.ts` | 输出边界与编码（`iconv-lite`） |
| `src/project-reader/git-status.ts` / `pro-state.ts` / `budget.ts` / `checkpoint.ts` | Git 状态、Pro 状态持久化、预算、检查点 |
| `src/project-reader/service.ts` | 只读/Pro 共用的服务层 |
| `src/domain/state-machine.ts` | 接力生命周期状态机与终态判定 |
| `src/domain/{canonical,idempotency,leases,errors,types}.ts` | 规范化、幂等、租约、错误分类、领域类型 |
| `src/workflow/{drain,handoff,return,supervision,reconcile,task-coordinator}.ts` | 排空、handoff、回接、监督、对账、任务协调 |
| `src/persistence/*` | 原子 JSON、事件日志、handoff store、redaction、索引缓存 |
| `src/adapters/*` | Codex App Server、Claude orchestrator、engineering-bridge、webgpt-drive（HTTP 与 in-proc） |
| `src/mcp/{server,schemas,result,tasks-list-receipt}.ts` | MCP server 装配、schema、结果封装、任务回执 |
| `src/quota/*` | 额度门控与归一化 |
| `src/security/{allowlist,confirmations}.ts` | 路径 allowlist 与高风险动作确认 |
| `src/evidence/evidence-writer.ts` | 证据落盘 |
| `src/routing/executor-policy.ts` | 执行者路由策略 |
| `src/web/auto-wakeup.ts`、`src/web/multi-task.ts` | **刻意未挂载**，见上文 |
| `src/{config,flags,runtime-config}.ts` | 配置解析、特性开关、运行时配置 |

## 不要做的事

- **不要挂载 `src/web/auto-wakeup.ts` 或 `src/web/multi-task.ts`**，也不要为它们补齐宿主。
- **不要把 `REAL_WEBGPT_DRIVE_CAPABILITIES` 改成 `true`**，不要删除锁住它的单元测试。
- **不要执行 Gate D-MOUNT**，不要改生产 Tunnel profile。
- **不要把本地合同证据表述成端到端验收通过**；不要宣称 G3/G4/G6/G7 已验证。
- **不要在未经明确确认的情况下打开生产接力开关**（drain / return / unattended 相关环境变量的生产取值）。
- **不要动 `handoff.md` 的校验逻辑**（数量 / 任务 ID / 内容 / 哈希四重校验不可放宽），也不要引入能“修复”不完整 handoff 的旁路。
- **不要把 web-quota 终态改成可恢复**：它对其 `relayEpoch` 必须是吸收态。
- **不要放宽 `src/security/allowlist.ts` 的路径校验**，也不要跳过 `confirmations.ts` 的高风险动作确认。
- **不要 `npm publish`**：`package.json` 的 `"private": true` 是防止误发 npm 的刻意设置。
- **不要提交本机配置文件**（`config/*.local.json`、`pro-workspaces.local.json` 及其 `*.pro-state.json`、`*.lock` 残留）。
- **不要在本仓库里执行破坏性 Git 操作或改动他人的工作区**；接力链路会回接原 Codex 线程，误操作会污染上游会话状态。
