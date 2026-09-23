# Pro 模式：Chat 聊天端直接操作本地项目

本文描述 Pro 模式的运行路径、权限模型与接入步骤。接入步骤见 [一句话使用指南](pro-one-prompt.md)，配置、验证、恢复与限制见 [连续编辑指南](pro-continuous-editor.md)。本仓库内的回归证据为本地合同证据，不等同于真实网页或真实账户的端到端验收。

## 运行路径

ChatGPT Chat → Secure MCP Tunnel → Continuity Pro → 直接读取 / 独立连续编辑器 / Engineering Bridge 补丁与可选 DSH。

非 Git、dirty 工作区、多文件创建/修改/删除及第二轮开发使用新的 edit_* 工具。配置、验证、恢复与限制见 [连续编辑指南](pro-continuous-editor.md)。

ChatGPT 自己分析源文件、编写 diff。读取、提交 diff、验证、应用不调用模型执行器。可选委派单独走 DSH，使用它自己的服务和额度；Pro 不提供 Codex 路由、模型切换、自动额度交接、commit 或 push 工具。项目测试本身会执行本机代码，固定 argv 不是操作系统沙箱，也不能保证任意测试代码不会调用外部服务。

`CONTINUITY_MODE=pro|reader|plus` 由 `npm start` 选择，默认 pro。这是产品预设，不是套餐检测。plus 保留旧实验入口，未宣称额度接力已完成。

## 接入步骤

1. 在正常 Windows 用户环境运行 `powershell -File scripts\manage-pro-tunnel.ps1 status` 检查后台连接；用 `start` 启动，用 `stop` 停止。脚本复用当前用户已有的 Tunnel 认证环境，不要把密钥发进聊天。
2. Tunnel 需要在使用本地工具期间运行。需要登录自启动时可运行 `scripts/install-pro-autostart.ps1`；代理（若环境需要）由使用者自行设置，脚本只在已设置 `CONTROL_PLANE_HTTP_PROXY` 时注入。
3. 在 ChatGPT **聊天**中刷新插件以获取最新工具集，其中包含 `continuity_local_*` 动态路径工具。日常手动使用聊天端只需 Pro 与 Tunnel 在线。
4. 使用 `continuity_pro_status` 确认 `mode: pro` 和 `codex_routing: disabled`，再调用项目列表与文件读取。
5. 独立 STDIO 自检 `node scripts/check-pro.mjs` 仅在后台 Tunnel 停止时运行，同一个 Bridge 配置只能持有一个 Pro 实例锁。它证明本地连接，不证明网页编辑成功。

给聊天端的起始指令示例：

> 使用 continuity_pro_status 和 continuity_projects_list 确认连接。读取该项目的 README、docs/ 与相关源码，先给出有文件和行号依据的项目现状、问题和修改计划。默认亲自读取和分析，不委派本地模型；不要把未执行的操作说成已完成。

原 Git 补丁路径的指令示例（先在一次性演示仓库上验证）：

> 修复演示项目的 math.js 加法错误，不修改测试。先读 README、源码和测试，取当前 Git HEAD，自己编写完整 unified diff，调用 continuity_patch_submit。启动 continuity_patch_validate 后用 continuity_task_result 轮询；只有 PASS 才以 APPLY 应用，最后回读源码确认。不要调用 worker，不提交或推送 Git。

## 权限模型

- 可读范围由 Pro reader 配置中的项目登记决定：只有登记过的工程才能被读取，`share` 再限定其中可见的目录/文件。
- 写权限必须显式授予：在专用 Bridge workspace 中登记同一工程的绝对、规范化根路径并设 `allow_write: true`，再将该 workspace ID 加入 Pro 的 `bridge.workspace_ids`（见下一节）。
- 未登记的工程不会被自动授予写权限。
- `allow_workers` 默认为 `false`，即不启用本地模型委派；DSH 只读派单需要对应 Bridge 工作区配置，并且只使用该执行器自己的服务与额度。
- 委派与补丁能力都限于登记工作区之内；Bridge 给予的是**整个登记工作区**的能力，不能用一个范围很窄的 reader `share` 来表达更窄的 Bridge 权限。

## 为真实 Git 项目启用补丁

本地管理员在 Pro reader 中登记要读的文件，在专用 Bridge workspace 配置中登记同一工程的绝对、规范化根路径和 `allow_write: true`，并把该 workspace ID 加入 Pro 的 `bridge.workspace_ids`。Windows Bridge 根路径使用原生反斜线的 JSON 转义写法。

Bridge 配置给予**整个登记工作区**的受控补丁/worker 能力；reader 的 `share` 只约束直接文件读取，并不是 Bridge 的子目录写入白名单。不要用一个范围很窄的 reader share 来表达更窄的 Bridge 权限。

Pro 配置的 bridge 字段：

```json
{
  "entry": "D:/tools/engineering-bridge/dist/src/mcp-stdio.js",
  "workspaces_config": "D:/bridge-state/pro-workspaces.json",
  "workspace_ids": ["my-project"],
  "allow_workers": false
}
```

状态文件与验证配置应放在获准写入项目之外。验证 profile 是 `${workspaces_config}.validation-profiles.json`，结构参考本机 `config/pro-workspaces.local.json.validation-profiles.json` 或 Bridge 文档。选择实际项目所需的构建和测试 argv；聊天工具不能修改 profile、授予写权限或执行任意 shell 命令。原配置和模型选择不会被继承成隐式 Codex 调用。

## 已验证的行为与剩余限制

- 真正的两层 STDIO MCP：客户端 → Pro → Bridge 1.4.4，临时 Git 项目里执行提交 diff、真实 FAIL/PASS 测试、失败拦截、应用和回读；未调用模型。
- 原 Bridge 补丁路径仍要求已有 commit HEAD 且工作区干净。新的连续编辑器不依赖 Git，支持 dirty 工程；当前 Continuity 源目录仍仅登记为可读，没有自动扩大权限。
- 原 patch APPLY 后留下未提交修改，不能继续当作干净 Git 基线。第二轮开发使用 edit_*，新 SHA256 和整个共享源码指纹保护当前改动。
- 验证异步返回 job ID，结果输出有上限并标明截断。失败与不完整不能当作 PASS。
- 补丁 ID、编辑提案、APPLY 回执及已观察到的 DSH 结果有界持久保存。重启不恢复验证 PASS 或 worker 控制授权。历史 worker 结果标记 historical、observed_at 和 current_process_verified=false；旧版没有保存正文的任务明确报告未知。应用回执不代表文件此刻仍未变化。
- 一个 Bridge 配置由磁盘实例锁约束；不同配置指向同一工作区不受这把锁统一保护。响应丢失或崩溃遗留锁需要本地核对后恢复，不自动删除锁或重放未知写操作。
- 连续编辑支持删除，重命名可表达为同一提案的创建与删除。没有任意交互终端、完整任务调度、自动依赖适配或对 Codex 效果的等价保证；大型项目需要配置共享源码和验证依赖。
- Pro 模式没有启动依赖于额度状态的模块；Plus 的自动接力仍保留为后续开发范围。
- 本机 `webgpt-drive` 返回过上一条回复。项目包装器现按真实用户消息及其后继助手回复核验归属；HTTP 成功仍不能代替工具和磁盘证据。连续编辑 APPLY 经一次保留所有检查的原工具复测成功，没有变更权限或绕过检查；具体平台内部原因未知。

管理脚本支持 `-Config <路径>` 进行隔离验收。同一 alias 一次运行一个配置；切换前使用当前配置停止，再使用新配置启动。带配置启动后，停止时也传入同一配置。变更权限范围会触发状态范围校验，不要删除历史或改校验值强行启动。

## 上游更新

本地旧版是 1.4.0 / `1e36fca312454c8d8d44e2fe11e1b52351ea4fa1`。已从 GitHub tag 下载 1.4.4 到独立目录 `_research/upstream-1.4.4/engineering-bridge-1.4.4`，用锁文件安装依赖并构建；原 Git 目录未替换。Pro 演示配置使用独立的 1.4.4 构建。

1.4.4 修复验证进程 stdin/进程树终止、Codex JSONL 帧边界、DSH 中断结果、workspace canonical identity。1.4.3 增加 Codex explicit routing，但它不能代替 Pro 的不调用 Codex 策略。

来源：[Bridge v1.4.4 release](https://github.com/wudy29/engineering-bridge/releases/tag/v1.4.4)、[ChatGPT MCP 连接说明](https://developers.openai.com/plugins/deploy/connect-chatgpt)、[Secure MCP Tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。账户的实际工具准入与额度规则由平台决定；本项目能保证的是自己的直接工具路径不启动 Codex 模型。
