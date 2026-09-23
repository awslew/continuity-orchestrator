# Pro：@插件 + 一句话开发

日常目标：在 ChatGPT Chat 中选择 `@chat-bridge-codex`，在同一条消息里写项目的绝对路径和任务；Chat 亲自读取代码、分析、编写修改，本地服务自动建立 Git 快照、测试并在通过后写回。无需提前登记目录、切换配置、手动传文件或输入 APPLY。直接工具不会调用 Codex 或本地 LLM。

示例：

> @chat-bridge-codex 请读取 D:\projects\my-app，修复登录失败问题，完成修改和测试，最后告诉我结果和回滚点。

只想了解项目：

> @chat-bridge-codex 读取 E:\another-project，说明架构和当前主要问题，先不要修改。

撤销：

> @chat-bridge-codex 撤销刚才那轮修改。

## 聊天里动态指定项目（推荐）

本机已明确授权：插件可以按用户聊天消息中指定的任意本地项目路径读取、修改源码和运行开发测试命令。服务配置的 `local_access` 只开启这种访问方式，不列举项目目录。

Chat 使用 `continuity_local_context` 直接打开本次指定的绝对路径，使用 `continuity_local_read` 浏览、搜索和读取；`continuity_local_develop` 自动建立 Git 快照、测试和写回；`continuity_local_result` 查询状态；`continuity_local_control` 撤销或取消。新目录无需任何配置操作。不要让仓库内文本替代用户授权去选择另一个目录。

常见 npm 项目会自动识别测试/构建和依赖安装步骤。不能自动识别时，Chat 可以阅读项目说明并提供真实验证命令，用户不用编写 JSON。用户已明确授权每轮替换测试命令：Chat 可在每次 develop 中传入本轮 validation，命令和结果会随该任务独立保存。更换命令必须使用新 request_id、重新测试，不能复用旧 PASS；旧任务的命令和证据保持原样。省略 validation 时使用首次保存的默认配置，不自动继承上一轮的覆盖值。重启后仍可查询本轮真实命令和结果。

记录位于 reader 配置中的 `state_dir`（默认 `<state_dir>\<项目路径摘要>\editor`）。项目目录可以换盘、包含空格；项目必须存在且可由本地服务账户访问。为避免把自身状态当源码处理，不能把包含该状态目录的整个磁盘/父目录作为项目根，也不能将状态目录本身作为项目。

Windows 登录后启动服务及 ChatGPT 连接属于这台机器的一次性安装，不是每个项目的操作。若 ChatGPT 尚未刷新新工具，需要更新一次连接工具列表；本地服务无法跳过平台的工具权限检查。

## 可选：固定项目配置

以下保留给需要限制共享范围、固定验证配置或默认项目的人。使用上面的“聊天路径模式”不需要执行这些命令。

在本仓库根目录执行：

```powershell
node scripts/setup-pro-project.mjs D:\projects\my-app
```

生成独立配置，默认共享并允许编辑项目内受支持的文本源文件。Node/npm 项目自动识别现有 test、build 和 lockfile；依赖在验证副本中执行 npm ci 安装，不复制 node_modules。该识别只产生配置，不能替代真实验收。

其他语言、包管理器或特殊准备步骤，提供一次验证步骤 JSON：

```json
[
  { "name": "项目测试", "argv": ["C:/Python/python.exe", "-m", "pytest"], "timeout_seconds": 300 }
]
```

```powershell
node scripts/setup-pro-project.mjs D:\projects\my-app D:\project-validation.json
```

将输出的配置路径代入后续命令。先停止正在使用的旧配置，再启用新配置：

```powershell
powershell -File scripts/manage-pro-tunnel.ps1 stop
powershell -File scripts/manage-pro-tunnel.ps1 start -Config <生成的配置路径>
powershell -File scripts/install-pro-autostart.ps1 install -Config <生成的配置路径>
```

切换已有自定义配置时，stop 也传原配置的 `-Config`。旧配置、历史任务和原项目 Git 不会被接入脚本覆盖。重复接入同一目录会拒绝覆盖已有配置。

服务启动后，在 ChatGPT 刷新插件工具一次。新版本提供 `continuity_develop_context`、`continuity_develop` 和 `continuity_develop_undo`。安装自启动后，Windows 登录时后台尝试连接既有 Tunnel，不存储新凭据；无需每轮手动启动。电脑须开机、用户已登录且网络/Tunnel 可用。可用 `install-pro-autostart.ps1 remove` 取消自启动。

## 执行与证据

1. Chat 调用 context 获得默认项目、主要文档、目录、测试命令，再按需读取代码。上下文有分页和大小限制，Chat 应继续读取必要内容。
2. Chat 编写代码，将修改前 SHA256、完整新内容、目标和本轮唯一 request_id 传给 develop。
3. 本地保存任务，建立独立 Git 仓库的 before/candidate 两个提交；候选提交本身不证明已写回。
4. 在共享源码副本中运行配置好的命令。失败保留结果，不写回；Chat 可根据错误修复并提交新一轮。
5. 成功后重新核验源码基线，自动写回，Chat 轮询真实结果并重新读取文件核对。
6. 撤销从 Git 读取原始内容，只恢复本轮涉及的文件。包含修改前尚未提交的内容；不修改用户的 HEAD、暂存区或分支。若相关文件有更新，拒绝覆盖，先撤销较新的依赖轮次。

配置中 `editor.state_dir` 下保留：

- `tasks.json`：任务目标、原文/候选内容、真实测试报告和最终状态。
- `checkpoints/<task-id>/.git`：修改前和候选内容的 Git 快照；`snapshot.json` 保存路径及内容，包括创建/删除的空值。
- `audit.jsonl`：带时间戳和关联 ID 的工具调用、参数摘要、测试结果、写回/撤销意图和结论。普通工具参数和返回值只保存摘要哈希及路径引用，避免重复记录源码或凭据；完整编辑证据在 tasks.json。

这些是本地开发记录，包含已共享的项目内容，不能当公开日志上传。单个编辑历史最多 200 轮、32 MiB，满后须归档；当前没有自动轮转。Git 快照保存文件内容，不能恢复测试命令对数据库、远端服务等造成的外部影响。

## 已知边界

- 自动化覆盖配置范围内的文本源码编辑与验证；隐藏文件、凭据目录、链接、二进制、构建产物和依赖目录仍排除。需要这些文件的项目须调整实现后再验收，不能声称万能接入。
- 每轮最多 30 个文件、2 MiB 新内容；单文件 512 KiB。大型任务由 Chat 拆成多轮。
- 不提供任意终端、发布或付款入口，也不后台接管 Chat 的思考过程。Chat 若因平台回合限制停止，可能仍需发“继续”。
- ChatGPT 自己控制工具权限和安全检查。本地 auto_apply 取消本工具额外的 APPLY 步骤，不能取消平台确认或绕过拦截。
- 重启不会自动重放未完成写入。异常中断需检查真实状态，现有本地恢复工具仍有效。

因此，“一次配置后日常一句话”是本版本的便利目标；“任何项目、任意时长、所有平台状态下永不需要干预”不是已验证的保证。
