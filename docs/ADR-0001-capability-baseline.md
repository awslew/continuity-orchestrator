# ADR-0001：Wave 0 能力与证据基线

- **状态**：Accepted as an evidence baseline; G1-G7 remain `未验证`
- **记录时间**：2026-09-01
- **唯一写入负责人**：`owner-w0-probe`
- **范围**：只记录 Wave 0 的本机只读探针、用户报告和证据缺口；不改变账号、Tunnel、Bridge 或生产配置。

## 1. 已观察到的本机事实

| 项目 | 观察结果 | 证据 |
|---|---|---|
| Node.js | `v24.16.0`，满足 Node 22+ | `evidence/g0/probe/capability-probe.json` |
| `engineering-bridge` | package version `1.4.0`，license `MIT`，engine `>=22` | 同上 |
| Bridge STDIO 入口 | `dist/src/mcp-stdio.js` 存在；本次只发送 `initialize`、`notifications/initialized`、`tools/list` | 同上 |
| Bridge 工具发现 | `tools/list` 返回 13 个工具；探针状态 `PASS` | 同上 |
| Bridge 工作区配置 | `workspaces.json` 存在；仅记录 SHA-256，不读取并持久化配置内容 | 同上 |
| Bridge dirty baseline | `M package-lock.json`；`??`：`diag-apply.mjs`、`diag-git.mjs`、`diag-submit.mjs`、`recreate-workspace.mjs`、`workspaces.json`、`workspaces.json.controlled-patches.json` | 同上；不得据此要求 clean |
| Secure MCP Tunnel doctor | profile 可读取；因当前探针进程未设置 `CONTROL_PLANE_API_KEY`，`control_plane_api_key` 为 FAIL，命令退出码 2 | `evidence/g0/probe/tunnel-doctor.txt` |

## 2. 用户报告与证据边界

用户提供的 `_research/admission-test-report.md` 报告称：个人 Plus 账号的 10 项一次性 Admission Test 全部通过，链路使用 ChatGPT 网页、Secure MCP Tunnel、engineering-bridge 和 DSH，且受控 APPLY 只改预期文件。

本 ADR 将其登记为：

- `userAcceptance: PASS`；
- `provenance: user-reported`；
- `machineEvidenceArchive: INCOMPLETE`，原始页面、Tunnel 调用、任务 receipt、完整 diff 和新对话复测原件尚未归档；
- 不把报告扩大为官方 Plus 权益承诺；
- 不把 DSH Admission Test 当作 Codex 原生 thread 的 `continue/steer/interrupt/accept/resume` 证据。Codex 原线程接力仍为未验证，必须在 G6/G7 实测并取得真实 receipt 后再放行。

完整状态、哈希和缺失类别见 `evidence/g0/manifest.json`。该 manifest 不保存 secret、cookie、API key、原始 transcript 或完整网页内容。

## 3. 决策与停止门

1. Wave 0 仅证明本机可读取的静态 Bridge/STDIO capability；不能证明 Codex 原线程控制、网页真实接力或后续 Orchestrator 集成。
2. `engineering-bridge` 的验收基准是相对 Wave 0 快照无新增、无覆写；现有 dirty work 必须保留，不 clean、不删除、不还原。
3. Tunnel doctor 当前因缺少运行时环境变量而未通过检查；Wave 0 不写入或索取 key，不启动 Tunnel。真实 Tunnel/网页验收另行由 G1/G4/G6/G7 门禁处理。
4. `webgpt-drive`、`claude_orchestrator`、`codex-chatgpt-web` 等外部资产的版本、许可证和接口指纹由 Wave 0 的资产基线记录（本仓库不发布该记录）；未定位的候选资产不得安装、克隆或被后续自动化宣称可用。

## 4. 后续 Gate 状态

| Gate | Wave 0 后状态 | 原因 |
|---|---|---|
| G0 | 用户验收 PASS；原始机器证据归档待补 | 仅报告和本机只读探针已归档 |
| G1-G7 | 未验证 | Wave 0 未执行真实单 App、额度控制、全量 thread 排空、网页监督、受控变更、原 thread 回接或重启安全验收 |

