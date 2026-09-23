# Plus / Pro 模式与直接操作工具（2026-09-12）

> 后续实现更新：独立 Pro 入口、模式选择器及真实本机补丁验证闭环已落地，见 [Pro 模式指南](pro-mode.md)。下文“尚未实现”等描述保留为本轮实现前的设计审查记录，以指南中的当前状态为准。

## 本次用户确定的需求

- **Plus 模式：** 保留原方案完整接力目标，包括短/周额度监测、交接文档、ChatGPT 接手续跑、必要的执行反馈与 Codex 恢复回接。此前分层交付不意味着删去这些最终需求。
- **Pro 模式：** ChatGPT 读取本地项目、给出指导意见，并能按用户要求向本地子代理派发任务、取得结果，从而间接修改项目。无需将额度触发、自动交接文档投递或自动回接作为依赖。
- 用户另外询问 ChatGPT 是否可以直接读写文件、不经本地子模型。本轮将它作为待纳入的执行选项建议，不擅自启用写权限或安装第三方程序。

## 建议的配置结构（尚未实现模式选择器）

对用户保留 Plus / Pro 两个预设；内部用独立能力组合，避免复制两套系统：

| 能力 | Pro 预设 | Plus 预设 |
| --- | --- | --- |
| 本地项目登记、直接读取/搜索、结果和证据 | 有 | 有 |
| 用户授权的本地子代理任务与结果回收 | 有，不依赖额度状态机 | 有 |
| 直接提交并受控应用 ChatGPT 编写的补丁 | 建议可选 | 建议可选 |
| 额度监测、自动 handoff、网页长时执行、回接 | 关闭且非启动依赖 | 按原目标实现、验证后启用 |

这些名称是产品预设，不是 OpenAI 套餐权限判断；用户可以手动选择，不能因检测到 Pro 就自动改变模型、执行器或授予写权限。

执行方式与模式正交：

1. `direct`：ChatGPT 自己阅读代码和编写变更，本机确定性工具执行读文件、应用补丁与获准测试，不调用另一个模型。
2. `delegate`：ChatGPT 发出目标与约束，本地子代理自行分析/实现，再返回结果供 ChatGPT 验收。调用仍需要用户授权，不能因工具存在就默认派单。

两条写路径共用工作区授权、差异审阅、版本检查和结果证据。对同一工作区的直接写入与 worker 写入必须互斥或隔离，不能各用一套锁并发覆盖。原有 clean Git / APPLY 门槛应明确显示；不可把“能读取当前 dirty 项目”推定为“可以直接应用补丁”。

## 当前本地实现与缺口

- `src/project-reader/` 已经是 direct-read：原文直接返回 ChatGPT，没有本地模型再概括。
- engineering-bridge 的 `submit_controlled_patch` 接受调用者提供的完整 diff 和精确 base HEAD；`ControlledPatchService.submit` 没有调用执行器，提案 `executor` 为 undefined。后续 apply 走本机 `git apply`。所以已有 direct-edit 的底层基础。
- Continuity 内部 `EngineeringBridgeAdapter.submitControlledPatch` 也存在，但新只读入口不暴露它；旧高层 propose 路径不能视作已经接通用户直接提交 diff。尚无新网页端直接写入验收。
- Pro 的 worker 执行不能强制先进入 `WEB_UNATTENDED_EXECUTING`，需要独立协作会话/任务生命周期；Plus 的 relay 编排在其上复用它。
- 目前没有完成 Plus / Pro 配置预设及 Pro 完整执行入口；本文件是需求修订，不是实现完成标记。

## GitHub 初步调研

以下为本轮读取仓库 README/工具说明得到的能力，不是安装、运行或安全审计结论。

| 项目 | 与直接读写相关的能力 | 对本项目的意义 |
| --- | --- | --- |
| [MCP Filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) | read_text_file、write_file、edit_file、目录操作；edit_file 支持 dryRun | 可作为纯文件工具基线，网页仍需要远程 MCP 传输；Roots 可替换启动允许目录，复用时需审查授权模型 |
| [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) | 读写、搜索、edit_block、进程和终端交互 | 可参考“自己读、自己改、自己跑测试”的完整工具集；其 allowedDirectories 不限制 shell，不能当 OS 沙箱 |
| [Remote Desktop Commander](https://github.com/desktop-commander/remote-desktop-commander) | 仓库明确说明 ChatGPT OAuth 接入及本机 device agent | 提供现成远程接入，但远程托管服务实现不开放源码，仓库主要是文档/manifest；与开源本地 server 区分 |
| [ChatGPT FileBridge](https://github.com/wuyinglai/chatgpt-filebridge) | workspace、read/write/edit/bash；Cloudflare Tunnel、OAuth 与本机管理页 | 贴近 Windows 网页直连使用流程；call_llm 为可选，文件操作不需要本地模型 |
| [ChatGPT Local Coder](https://github.com/hoangcoderr/chatgpt-local-coder) | README 列出直接文件编辑、apply_patch、shell、Git、Secure MCP Tunnel | 已从最初命中的 posavr fork 追到该上游；参考完整工具覆盖。文档宣传全盘访问/包含 push，不能直接照搬默认权限；当前上游有 MCP_TOKEN 配置，不应沿用旧 fork 的无认证示例 |

## 推进建议

优先完成 Pro 的共用协作核心：直接读取的网页验收 → 将已有 caller-supplied patch 路径接入并验收 → 独立 worker 派发/回收；Plus 保留完整目标，随后复用协作核心完成自动化层。不要为了新增 Pro 再复制一个 Bridge，也不需要为了 direct-edit 先实现整个额度接力。

## 2026-09-23 补齐进展

对照本文第 7 行确定的 Plus 模式 5 大目标，当前本地合同接线落地与未闭合边界如下：

1. **短/周额度监测 (Quota Monitoring)**
   - **落地情况**：工具 `continuity_quota_snapshot` 已接入，提供 primary/secondary 额度窗口、剩余 basis points、freshness 时间戳与 gate 决策支持。
   - **未闭合部分**：当前仅有 4C 真实探针单次取证，生产环境真实持续轮询尚未开启，全部依据本地合同门控。

2. **交接文档 (Handoff Document & Drain)**
   - **落地情况**：
     - 新增 `continuity_task_register` 注册任务并绑定 `remaining_work` 的 hash。
     - 新增 `continuity_drain` 走真实 drain workflow，中断全部可见活跃 Codex 线程，落盘 `DRAINING` 并推进到 `HANDOFF_READY`；未通过 drain fence 时停在 `DRAINING` 记录结构化 fault。
     - 单一事实源 `handoff.md` 已建立，缺失时可自动从中重建 manifest；`prepareHandoff` 严格使用入参 `expected_revision` 乐观锁。
   - **未闭合部分**：本地合同测试全部覆盖，真实复杂项目下的多线程交接尚待真实场景验证。

3. **ChatGPT 接手续跑 (ChatGPT Unattended Takeover)**
   - **落地情况**：工具面提供 `continuity_web_session`（create/attach/send/read/stop）、`continuity_handoff_manifest_read`、`continuity_handoff_chunk_read`、`continuity_handoff_accept` 与 `continuity_worker_run`，支持 web 端按 chunk 校验哈希并记录 accept receipt。
   - **未闭合部分**：真实网页驱动能力（`REAL_WEBGPT_DRIVE_CAPABILITIES` 四项）刻意全设为 `false`，Gate D-MOUNT（切生产 Tunnel profile）处于未执行状态，端到端真实网页续跑尚未挂载。

4. **必要的执行反馈与 Worker 控制 (Execution Feedback & Worker Control)**
   - **落地情况**：
     - `continuity_worker_control` 已接通 `WorkerSupervisionController` 与 `BridgeWorkerControlBackend`（支持 `bridge-dsh` 类型 worker 的 continue/steer/interrupt/accept）；控制未确认时回滚状态（`WORKER_CONTROL_NOT_CONFIRMED`，`rolled_back: true`），绝不谎报停止。
     - `continuity_worker_run` 返回 `attempt_revision` 并持久化 attempt 记录。
     - `planReconciliation` 接入 web 异常路径：传输失败时任务停在 `BLOCKED_WAITING`（`RECEIPT_LOSS_RECONCILE_REQUIRED`），不盲目重发。
     - `LocalWorkerBackend.resolveBinding` 仅在恰好配置 1 个 Bridge workspace 时才自动绑定，多配置时 fail-closed；DSH 取落盘 checkpoint，Claude 复用已记录真实 session。
   - **未闭合/刻意未挂载部分**：
     - `src/web/auto-wakeup.ts` 刻意未挂载（stdio MCP 进程无调度宿主、payload 会被真实传输拒绝、schema 不可达）。
     - `src/web/multi-task.ts` 刻意未挂载（纯内存注册表无法跨重启持久化、锁未落盘）。
     - `workflow/reconcile.ts` 中的 `planForSnapshotEntries` 仍为纯投影函数，无生产调用者（仅供重启演练）。

5. **Codex 恢复回接 (Codex Resume & Return)**
   - **落地情况**：
     - `continuity_prepare_return` 采用纯决策函数 `assessReturnReadiness`，执行 5 项严格就绪检查，`returnCheckpointComplete` 从 `ledger.checkpointRef` 派生。
     - `continuity_resume_codex` 已接通 `CodexAppServerAdapter.resumeThread`，由 `CONTINUITY_RETURN_TO_CODEX_ENABLED` 门控；需要账本 checkpointRef，只有拿到证实收据（原线程 ID + 新 turn ID + receipt ID）才推进到 `CODEX_RESUMED`，否则保留在 `RETURN_READY` 可重试。
     - 引入 `FileRelayServerStore`（`relay-runtime.store.json`）持久化 patch、幂等收据（≤2000条）与 worker attempt；生产启动时 `TaskCoordinator.hydrate()` 从 `.ai-handoff/<taskId>/state.json` 恢复任务。
   - **未闭合部分**：Codex App Server 生产回接未在生产真实环境端到端触发，保持本地适配器合同验证。

