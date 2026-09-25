# Continuity Orchestrator

## 这个项目想解决什么

### Pro：在 Chat 里直接读改本机项目

你想在 ChatGPT 里直接说“读取这个本机项目、修好问题并跑测试”，不想手工上传文件、复制代码或另开本地模型。**Pro 模式**让你在 Chat 端调用 `@chat-bridge-codex` 插件，在消息中指定项目绝对路径和任务；插件可按授权直接读取、搜索、修改本地源码，建立修改前快照、运行测试并在通过后写回，必要时可撤销。不需要先逐项目登记，也不依赖 Codex 额度接力。

Pro 需要在本机显式开启 `local_access`、完成 ChatGPT 连接，并遵守 ChatGPT 的工具权限检查。具体用法见 [一句话使用指南](docs/pro-one-prompt.md) 与 [连续编辑指南](docs/pro-continuous-editor.md)。只想读取时，可使用独立的**只读入口**查看明确共享的目录、源码和真实行号。

### Plus：Codex 额度用完后让网页版 ChatGPT 接着做（目标）

你在 Codex 里做的任务还没完成，Codex 额度却快用完了；与此同时，网页版 ChatGPT 还有可用额度。**Plus 模式的目标**是把剩余任务交给网页版 ChatGPT 接着做，等 Codex 额度恢复后回到原线程，让两边的额度接力使用。

**当前状态：**Plus 链路通过了本地合同测试，但真实网页版 ChatGPT、真实账户与生产传输的端到端接力**尚未验证**；生产接力默认关闭。仓库内的回归结果也不能代替 Pro 的真实网页和账户验收。

**In English:** Pro lets ChatGPT use a plugin to read and edit a local project directly, with explicit local access and tests. The separate Plus goal is to hand unfinished Codex work to web ChatGPT when Codex quota runs low, then return to the original thread; real web handoff is not yet verified.

## 从项目读取开始

需要 Node.js 22+。在此目录安装依赖、构建，将示例复制为本机配置，修改项目根路径与允许共享的目录：

```powershell
npm ci --ignore-scripts
npm run build
Copy-Item config/projects.example.json config/projects.local.json
# 编辑 config/projects.local.json 中的 root 与 share
$env:CONTINUITY_PROJECTS_CONFIG = (Resolve-Path config/projects.local.json).Path
npm run reader:check
npm run reader:stdio
```

STDIO 入口启动后等待 MCP 客户端输入，终端没有欢迎文字是正常现象。客户端配置和网页连接步骤见 [项目读取指南](docs/project-reader.md)。网页 ChatGPT 需要实际可用的 Developer Mode 与 Secure MCP Tunnel 或受保护的 HTTPS MCP 传输；本项目不保证所有 Plus 账户准入。

| 入口 | 当前能力 | 依赖 |
| --- | --- | --- |
| `dist/src/project-reader/mcp.js` | 4 个只读工具：列项目、列目录、按行读取、字面量搜索 | 本机显式项目配置；无本地模型调用 |
| `dist/src/project-reader/pro.js` | 12 个基础工具；连续编辑另加 5 个，默认项目自动开发另加 3 个，动态路径另加 5 个；本机全部启用共 25 个 | 动态路径只需本机启用 local_access；不需逐项目配置。原 diff 和可选 DSH 路径另外配置 Bridge |
| `dist/src/main.js` | 20 个接力工具；已接通任务注册、完整 drain 到 HANDOFF_READY、受监督 worker 控制与回接原 Codex 线程 | 显式 runtime 配置、相应后端及 feature flags |

当前 relay 入口已完成本地合同接线（包括 `continuity_task_register` 注册账本、`continuity_drain` 完整排空与 handoff 生成、Bridge worker 受控监督及回滚、`continuity_resume_codex` 原线程回接与 `FileRelayServerStore` 跨重启持久化），详见 [Plus 模式说明 (2026-09-23)](docs/plus-mode-2026-09-23.md)。默认 dry-run 开启、生产接力开关由环境变量门控（如 `CONTINUITY_AUTO_DRAIN_ENABLED`、`CONTINUITY_RETURN_TO_CODEX_ENABLED`）。

## Plus（接力）模式的当前状态与边界

- **生命周期与终态**：`CODEX_ACTIVE -> DRAINING -> HANDOFF_READY -> WEB_UNATTENDED_EXECUTING -> WEB_TERMINAL -> RETURN_READY -> CODEX_RESUMED`。封闭终态原因仅限 `ALL_TASKS_COMPLETED`、`WEB_QUOTA_EXHAUSTED` 与 `HUMAN_STOP` 三种；普通网络抖动/超时/阶段完成均不是终态。
- **证据边界**：当前全部接力证据为**本地合同证据（Local Contract Evidence）**，不代表真实网页或真实账户端到端已通过。Gate **D-MOUNT**（将生产 Tunnel profile 切换至 Continuity App）仍为**待用户明确确认才可执行**的动作，当前未执行、未验证。
- **能力门控**：`REAL_WEBGPT_DRIVE_CAPABILITIES` 四项全 `false` 是刻意且经过单元测试固定的安全决定；生产环境默认不开放未验证的真实 web 传输。
- **刻意未挂载模块**：
  - `src/web/auto-wakeup.ts`：进程内无调度宿主（stdio MCP 服务内 `setInterval` 计数为 0），其 payload 格式会被真实传输拒绝，且内部引用类型在 MCP schema 边界不可达。
  - `src/web/multi-task.ts`：纯内存隔离注册表，跨重启无法持久化恢复任务映射，且其项目锁未做持久化。


## 验证与开源准备

```powershell
npm run typecheck
npm run test:reader
npm run test:unit
npm run test:integration:mock
```

`test:reader` 和 `test:pro` 包含真实临时文件与 MCP 子进程测试。已有真实网页源码读取证据；网页执行的完成情况应查看日期明确的验收记录，不能由本地测试推断。

本仓库已公开并采用 MIT 许可证；`private: true` 保留以防误发 npm。个人 `evidence/`、本机项目配置、账本和浏览器资料均不属于发布产物。旁边的 engineering-bridge 是独立的第三方 MIT 项目。

## Experimental Plus lifecycle contract

The experimental Plus relay uses this lifecycle (the independent Pro entry does not load it):

```text
CODEX_ACTIVE -> DRAINING -> HANDOFF_READY -> WEB_UNATTENDED_EXECUTING
              -> WEB_TERMINAL -> RETURN_READY -> CODEX_RESUMED
```

`WEB_UNATTENDED_EXECUTING` has `EXECUTING`, `RETRYING`, and `BLOCKED_WAITING` substates. A stage completion, empty ready queue, error, timeout, Codex recovery, or ordinary human message is not terminal. The closed terminal reasons are `ALL_TASKS_COMPLETED`, `WEB_QUOTA_EXHAUSTED`, and `HUMAN_STOP` only. A web-quota terminal is absorbing for its `relayEpoch`; recovery is recorded as data and cannot resume web execution.

`handoff.md` is the Markdown source of truth. Its complete `remaining_work` set is checked by count, task ID, item content, and hash. A sidecar cannot repair a missing or incomplete Markdown handoff.

## Commands

```powershell
npm ci --ignore-scripts
npm run typecheck
npm run test:unit
```

Tests use temporary directories and do not write a user repository ledger. No package lifecycle scripts are required for installation.

## Evidence boundary

Passing unit tests are local contract evidence only. They are not real web, Tunnel, App Server, Bridge, account, or worker evidence; G3/G4/G6/G7 remain `未验证` until their specified real receipts exist. The Plus Admission Test is preserved as user/account evidence, not a universal plan guarantee.

`docs/ADR-0004-recovery-and-retention.md` records historical recovery decisions. Its acceptance is not proof that all production recovery paths have been implemented or verified.
