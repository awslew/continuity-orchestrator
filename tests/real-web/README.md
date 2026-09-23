# tests/real-web — 真实网页验收测试（Wave 6）

本目录是**真实网页验收**的测试锚点（plan §10.3.4 / §10.5 / G7）。它**不是**
`npm test` 的一部分：本目录内的测试只有在验收人（用户）按安全确认流程执行真实
网页路径时才有意义；mock/单元套件永远不能替代这里。

## 状态

当前为空（`README.md` 之外没有测试文件）。原因：

- 真实网页验收依赖 4C（webgpt-drive receipt/cursor/quota 合同补齐，当前
  `ASSET_LOCATED_CONTRACT_GAPS/BLOCKED`，待用户授权）与 4D（Tunnel Read+Use
  单 App 发现，待用户开启 Tunnel 会话）；
- plan §10.5 规定 G7 只有在攻击用例、重启/watchdog 对账、权限审计、A-L
  对抗性用例和真实网页 evidence bundle 全部存在时才可通过。

在 4C/4D 证据落地前在本目录编写并运行任何"真实"测试都会是伪造——mock 环境
的重复实现不产生真实网页证据。

## 验收执行顺序（4C/4D 通过后）

1. 验收人按 `docs/real-web-evidence.md` 的 bundle 格式，在
   `evidence/g1-g7/real-web/` 收集 A-L 案例证据；
2. 运行 `node scripts/verify-real-web.mjs --evidence-root "evidence/g1-g7/real-web"`
   得到完整性报告（组织证据，不判 PASS）；
3. 每个关键动作同时能对上五元组：页面可见状态 + MCP tool receipt + 本地
   worker/文件/Git 证据 + events.jsonl + 状态机下一状态（§10.5）；
4. 用户确认后，本目录补充的每个真实网页测试才允许引用这些 bundle 作为输入。

## 红线

- 当前窗口（进行中的 Codex 会话）永不作为实验目标；
- interrupt/resume（4F）必须用户再次明确确认，且只针对非当前测试任务；
- 不做人工网页代跑（D-007）；mock PASS 不冒充真实 PASS。
