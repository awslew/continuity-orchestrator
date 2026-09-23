# Pro 连续编辑与本地执行

Pro 的直接工具不启动本地模型。聊天模型亲自读取文件、提出修改；本机服务负责版本检查、运行命令、保存回执和应用修改。Bridge 仍提供原有 Git diff 路径和可选 DSH 委派。Plus 额度交接是另一条实验路径。

## 配置与启动

需要 Node.js 22 或更新版本。连续编辑器自身不依赖 Git 或 Engineering Bridge。

```powershell
npm ci --ignore-scripts
npm run build
Copy-Item config/pro-editor.example.json config/pro.local.json
# 按实际工程修改 reader、editor.state_dir、writable_paths 和 validation。
node scripts/pro-doctor.mjs config/pro.local.json
$env:CONTINUITY_PRO_CONFIG = (Resolve-Path config/pro.local.json).Path
node dist/src/project-reader/pro.js
```

最后一个命令是 STDIO MCP 服务入口，应该由 MCP 客户端或 Tunnel 启动。它等待协议输入，不是终端聊天程序。现有本机配置已经存在时，不要覆盖，合并所需字段即可。

`reader.projects[].share` 定义直接读取和验证快照的源文件范围。`editor.workspaces[].writable_paths` 必须处于对应 share 内，进一步定义可修改范围。状态目录必须位于所有共享项目之外。示例中把源码、测试和 README 设为可写；管理员可进一步缩小范围。

未登记、隐藏、敏感名称、二进制、链接和生成目录不会作为普通共享源码提供。可编辑文件每个最多 512 KiB；一次提案最多 30 个路径、替换内容总计 2 MiB。

验证快照按**原始字节**复制共享工作文件，不再只支持 UTF-8：UTF-8（含/不含 BOM）、UTF-16 LE/BE（含/不含 BOM）和 GB18030 都会被识别；修改按文件自身编码写回，BOM 与换行风格保持不变。二进制文件和超过单文件预算的生成物不会被当作文本，而是按字节原样保留、列入 `snapshot_omissions` 并在结果中说明真实原因，不会让整个开发轮次失败。

无 BOM 且整段都是 CJK 字符的 UTF-16 文件与 GB18030 在字节层面无法区分（两种码页都能无损往返），这类文件按不透明字节处理并保持不可编辑：宁可少支持一种罕见编码，也不能按错误码页改写全文。

Git 项目的快照范围优先使用 `git ls-files --cached --others --exclude-standard`，因此 `.gitignore` 就是权威：`node_modules`、`work/`、数据库、视频、音频和构建产物不会被复制。非 Git 项目退回目录扫描，只按名称排除必然属于缓存/包管理的目录（`node_modules`、`__pycache__`、`.venv`、`.next` 等），`vendor/`、`dist/`、`target/` 这类可能存放源码的目录不再被跳过。默认预算为单文件 32 MiB、总计 64 MiB、8000 个文件，可在 `editor.workspaces[].limits` 覆盖（`file_bytes` / `total_bytes` / `total_files`）。单文件超限进入 omissions；累计超出总预算以 `SNAPSHOT_LIMIT` 拒绝，而不是静默验证残缺快照。omissions 列表最多列出 400 条，总数在 `snapshot_scope.omissions_total` 里始终精确。

被省略的文件不可编辑：提案会以 `FILE_LIMIT` 拒绝并说明真实原因（超出单文件预算、二进制/未知编码、隐藏路径、硬链接等）与当前预算，因为这些文件无法进入验证副本。

Git 快照给出的共享范围如果一条都没匹配到（例如 share 指向仓库之外），服务不再静默复制空集合，而是退回目录扫描，避免把“工程为空”当成真实状态。

## 给聊天端的工作约定

> 先调用 continuity_pro_status 和 continuity_projects_list。读取相关文件及测试，报告计划。若项目登记在 continuous_editor 中，使用 edit_* 工作流：根据每个文件当前 SHA256 提交提案，验证并轮询到最终结果，失败时读取真实输出后修正提案；只有 PASS 才以 APPLY 应用，最后重新读取文件确认。第二轮继续用新的文件 SHA256，不要求提交 Git。不得把文字陈述当作执行证据。没有明确授权时，不调用 worker。

| 工具 | 行为 |
| --- | --- |
| `continuity_edit_propose` | 保存修改提案，不改原项目。现有文件带 expected_sha256；新文件为 null；content 为完整新内容，null 表示删除 |
| `continuity_edit_validate` | 在独立源码快照内运行本地配置的验证命令，立即返回任务 ID |
| `continuity_edit_result` | 返回 ready、state、命令退出码、实际输出、变更文件哈希及错误；保留重启后的历史 |
| `continuity_edit_apply` | 需要本会话验证 PASS 和明确 APPLY，重新检查整个共享源码快照后应用 |
| `continuity_edit_cancel` | 取消当前验证，等待终止结果；取消或终止不明不能授权应用 |

修改、创建、删除和多文件组合均使用相同版本检查。重命名可表达为同一提案中的创建和删除。已有未提交修改会成为当前基线，暂存区和 Git HEAD 不改变。

应用是逐文件的原子替换，不是整个目录的操作系统级事务。发生普通写入失败时，服务尝试回滚本次已写入且仍匹配提案版本的文件。发现外部并发修改就保留它并报告冲突。运行其他编辑器时，仍应避免同一时刻改同一个文件；这不是对恶意本地进程的隔离机制。

## 验证命令与依赖

命令来自本机配置，聊天工具不能新增任意终端命令或改验证配置。argv 直接启动可执行程序，不经过 shell；Windows 的 npm.cmd / PowerShell 脚本不能直接作为可执行文件使用，应指定 Node 加 CLI 的 .js 路径，或本机明确配置的解释器。

验证复制共享的**工作文件字节**（不是只复制受支持的文本扩展名），不复制 `.git`、`node_modules`、`.gitignore` 忽略的路径、隐藏配置或外部依赖。需要依赖的工程应把 package.json 和锁文件列入版本管理，并在 validation 前面加入经过本地审阅的安装/准备步骤，例如 Node 启动 npm-cli.js 执行 `ci --ignore-scripts`，再执行测试。不要把“缺依赖导致验证失败”当成业务代码失败。

每个命令有 1–300 秒时限，最多 8 步；输出有明确截断标记。标准输入关闭，避免测试等候输入。取消或超时会终止进程树；无法确认终止时进入需要本地处理的状态。命令若改写候选源码，不能得到 PASS。可丢弃的验证目录建在系统临时目录 `%TEMP%\continuity-validation\<uuid>` 下，与用户工程没有相对路径相连，正常完成后清理，报告和提案保存在状态目录。

验证子进程不继承 Tunnel/API 密钥环境变量或 NODE_OPTIONS。它仍以本地用户的系统权限执行工程代码，能够访问该用户可访问的资源（包括用绝对路径访问工程本身），因此只应对可信项目配置命令。这不是操作系统沙箱。

被 omissions 排除的文件（隐藏配置、`.gitignore` 忽略的路径、二进制、超预算文件）**不在验证副本里**：工程代码会按“文件不存在”处理，可能走到兜底分支而误判 PASS。因此结果里同时给出 `snapshot_omissions` 与 `snapshot_scope`（`omissions_total`、`captured_files`、`omitted_truncated`），核对后再决定是否采信这次 PASS；例如 `.env` 被排除时，任何依赖环境变量的用例都不可信。

## 重启和恢复

提案、原内容、文件哈希及应用回执持久保存。重启不复用旧验证 PASS，必须重新验证。`applied: true` 表示历史上应用成功，`current_files_verified: false` 提醒调用方继续回读当前文件。

本机 `manage-pro-tunnel.ps1 start|status|stop` 管理已有 Tunnel。Windows 下停止时会核对状态锁拥有者与本项目入口，只停止对应的 Pro 进程树。启动前可归档已退出进程留下的空闲锁；未完成写入、正在验证或需要核对的 worker 历史会阻止自动恢复，不重放操作。

连续编辑出现中断时，停止服务后先检查：

```powershell
node scripts/recover-pro-editor.mjs config/pro.local.json inspect TASK_ID
# 若确认原进程已退出但遗留实例锁，显式允许检查并归档死进程锁：
node scripts/recover-pro-editor.mjs config/pro.local.json inspect TASK_ID ACKNOWLEDGE_LOCAL_RECOVERY
# 只有当前文件仍匹配 before 或提案版本，才允许以下恢复：
node scripts/recover-pro-editor.mjs config/pro.local.json rollback TASK_ID ACKNOWLEDGE_LOCAL_RECOVERY
```

若有外部修改或进程终止不明，自动恢复会拒绝，需要本地核对。不要直接删除状态目录；其中包含回滚资料。状态目录最多保留 200 个提案 / 32 MiB 日志内容；到限后应先审阅、备份历史，在停机状态下使用新的状态目录。

## 可选 DSH

Bridge 配置可设置 `allow_workers: true`，必要时用 `dsh_home` 指定已有 DSH 配置目录。Pro 使用用户的原生 DSH 配置，不选择模型、供应商或推理档位，不传入 Tunnel 凭据；执行器明确指定为 dsh，并由 Bridge 使用只读执行模式。DSH 使用它自己的服务与额度。

聊天端可以显式派发分析或补丁生成任务、读取结果、继续/调整/中断当前会话启动的任务。生成补丁仍需审阅和验证后应用。已观察到的 worker 结果正文有界持久保存；重启查询标明 historical 和 observed_at，不自动恢复控制权，也不把过去的 running 标记当作当前进程仍在运行。旧版本仅保存 ID 而未保存结果的任务会报告 WORKER_HISTORY_UNAVAILABLE。已明确完成的 DSH 结果允许空闲锁恢复；未知结果或后续控制响应丢失仍会阻止恢复。

真实 DSH 委派的验收需要显式授权并在使用者自己的机器上单独进行（该一次性验收脚本由维护者保留，不随本仓库发布）。普通回归不启动真实模型。

## 验收标准

本地运行 `npm run test:pro`；完整回归使用构建后的全部单元与集成测试。另需用实际 Chat 客户端完成读取、提案、验证、应用、回读与第二轮修改。HTTP 成功、模型声称成功或本地测试通过，均不能单独代替网页端验收。

网页端测试不依赖任何本地模型或浏览器驱动：只需要 Pro 服务与 Tunnel 在线，由 Chat 自己读取、提案、验证、应用并回读。可选的页面自动化能力属于使用者自行接入的外部组件，不在本仓库的发布范围内。
