# DWS Codex Bridge

通过 DWS 把钉钉数字员工与本机 Codex App Server 接起来。在指定群中交办任务，本机 Codex 处理后，将进度和答案写回同一张 A2UI 卡片。

```text
钉钉群聊 → DWS CLI → Node.js 桥接程序 → Codex App Server
              ↑            进度和结果回群            ↓
              └─────────────────────────────────────┘
```

## 能力与范围

- 校验数字员工身份、发送者开放 ID 和指定群聊，只有配置的本人能触发本机任务。
- 按会话复用 Codex 线程，以消息 ID 去重，追问可以延续上下文。
- 同一卡片显示处理中、公开进度、最终答案或失败原因。
- 创建新卡片时显式开启转发；实际转发效果需在目标客户端验证。
- 支持消息中的图片引用，由 DWS 下载后作为本机图片交给 Codex。
- 最终答案中的本机截图可由宿主上传为普通图文消息，卡片显示交付结果，避免无效图片占位。
- 提供本机只读日志页和终端查看器。

这是个人电脑上的桥接示例。电脑需保持在线；它使用你已有的项目环境与 Codex 登录。数字员工“服务对象”的可见范围不等于本机 Codex 的触发权限。

## 准备

1. Node.js 22 或更新版本，macOS 或 Linux。后台进程管理使用 POSIX 进程接口，Windows 暂未验证。
2. 已安装并登录的 [DWS CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)，具备数字员工身份、群消息监听、图片下载和 A2UI 卡片创建与更新能力。开发时使用 DWS v1.0.65，其他版本请先核对对应命令。访问企业数据需要相应的企业管理员授权。
3. 已安装、已登录且支持 `app-server --stdio` 的 Codex CLI。
4. 一个用于交办任务的群，以及已发布数字员工对应的可用 DWS profile。profile 的创建方式见 DWS 的[数字员工接入说明](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/skills/multi/dingtalk-tag/references/manage-and-connect.md)。

源码仅使用 Node.js 内置模块，无需安装第三方运行依赖。DWS、Codex CLI 及其凭据均由使用者自行准备。

## 快速开始

```sh
cp config.example.json config.json
```

编辑 `config.json`，填写本机可执行文件路径、项目目录、数字员工身份、自己的开放 ID、目标群和当前账号支持的模型配置。模板里的占位符必须替换。

代码统一使用 `main`，模型、路径和网络开关等本机差异保存在已被 Git 忽略的 `config.json` 中，不需要维护单独的运行代码分支。只提交使用占位值的 `config.example.json`；不要提交真实配置。

| 配置项 | 含义 |
| --- | --- |
| `dws` / `codex` | DWS 和 Codex 可执行文件的绝对路径；DWS 也可以指向已有的身份隔离包装脚本 |
| `profile` | 已配置的数字员工 DWS profile |
| `employeeUserId` / `employeeName` | 预期的数字员工身份，可用对应 profile 的 `dws contact +me` 核对 |
| `supervisorOpenId` | 允许交办任务的本人开放 ID，按数字员工视角解析，不能直接用工号代替 |
| `groupConversationId` | 唯一允许触发任务的群会话 ID |
| `cwd` | 允许 Codex 处理任务的本机项目绝对路径 |
| `model` / `effort` | 当前 Codex 模型目录支持的模型和推理档位 |
| `serviceTier` | 默认 `null`；需启用 Fast 时设为 `priority`，启动前会验证账号是否支持 |
| `networkAccess` | 可选布尔值，默认 `false`；需要联网的本机任务可在 `config.json` 中明确设为 `true`，不接受字符串或 `null` |
| `stateDir` | 可选；默认配置文件旁的 `.state`，存放去重、会话和进程状态 |
| `dwsConfigDir` / `dwsKeychainDir` | 可选；已有的 DWS 配置与加密凭据目录，同时传给 DWS 和 Codex 子进程 |

先做连接检查，再启动：

```sh
node bridge.mjs check
node bridge.mjs start
node bridge.mjs status
```

`check` 核对已有身份、登录状态和模型目录，不发群消息、不启动模型任务。检查成功后，在指定群内用自己的账号发一条简单文本，验证进度卡片与最终回复。

也可在前台运行，便于排查启动问题：

```sh
node bridge.mjs run
```

停止后台进程：

```sh
node bridge.mjs stop
```

需要把配置放在仓库外时，所有管理命令使用同一个配置路径：

```sh
DWS_CODEX_CONFIG=/absolute/path/bridge.json node bridge.mjs start
DWS_CODEX_CONFIG=/absolute/path/bridge.json node bridge.mjs status
DWS_CODEX_CONFIG=/absolute/path/bridge.json node bridge.mjs stop
```

后台子进程会沿用同一份配置文件。启动命令成功仅表示进程已创建，应结合 `status` 和实际消息往返判断连接是否可用。

## 日常使用

在指定群里发送任务即可，无需额外的转发服务。建议先从公开项目的只读分析开始，例如：

> 帮我看一下 utoo 的这个公开 issue，你会如何处理？先只读分析，说明改动位置、实现思路和验证方法。

授权用户的后续追问继续使用同一会话。消息正文中的 `[图片消息](mediaId=...)` 会由宿主下载；单条最多 4 张，单张不超过 10 MiB、总计不超过 20 MiB，支持 PNG、JPEG、GIF 和 WebP。

保存的线程被其他应用占用写入端时，宿主只对明确的 writer 冲突创建独立线程，保留存储历史，不中断另一端。新线程通过目录、沙箱、模型与档位校验后，先持久化会话绑定，再开始当前任务；失败时不自动创建空白会话或重跑旧任务。

### 回复卡片

新回复使用 `chat message send-a2ui-card` 创建，并通过 `update-a2ui-card` 更新同一实例。卡片只含一个 Markdown 根组件，创建时包含完整 Surface、初始数据和非空正文，后续更新保留组件及 Surface ID，并同步 `fallbackMarkdown`。公开进度累计展示，完成后替换为完整答案，模型和速度作为正文的一部分显示。

创建请求显式传入 `--support-forward`，群聊与单聊沿用已校验的原目标和身份。该设置只对新建卡片生效，当前更新接口不能给旧卡片补开转发。服务端接受 `supportForward=true` 与客户端实际完成转发是两项独立验证。

已知失败会在正文标明“任务未完成”，再以 `FINISH` 结束输出；该状态表示流式输出结束，不代表任务成功。更新结果不明时停止后续写入，不自动重新创建。已有卡片不跨接口迁移，也不重放历史任务。

客户端显示、转发和交互仍需独立验收。聊天内底部升级提示的来源尚未确定，不能据此认定客户端版本低；Schema 校验通过或服务端回执成功也不代表提示已消失。

### 截图与图片交付

将生成的图片保存在配置工作目录的 `outputs/` 下，并在最终答案中以 `![图片说明](outputs/result.png)` 引用。宿主会使用现有 DWS profile，将已验证的图片另发为普通图文消息，目标仍是原来校验过的会话或主管。原生图文的显示和转发效果需在自己的客户端验证；本地测试不会实际上传或发消息。

出站图片只接受 `outputs/` 或 `downloads/dingtalk-images/` 内的 PNG、JPEG、GIF、WebP，限制每次 4 张、单张 10 MiB、合计 20 MiB。宿主检查真实路径和文件内容，将已验证的字节复制到 `outputs/bridge-outbound-images/` 私有任务目录，再交给 DWS，避免特殊路径影响上传。临时资源按需由使用者清理。

每次交付先保存幂等键，发送后保存唯一任务回执，再查询投递状态；结果不明时不重发。卡片中的本机图片会改为简短说明，只有回执确认后才提示“原图已另发”；公开图片地址、结果链接及代码示例继续保留。公开进度只采用当前轮次的 commentary，不把历史消息或内部推理写入卡片。

源码更新后，在当前任务结束时重新启动宿主加载新代码：

```sh
node bridge.mjs stop
node bridge.mjs start
```

历史卡片和历史图片不会自动重发。升级只涉及源码，沿用现有配置与登录。

## 本机执行日志

桥接启动后尝试提供只读页面：<http://127.0.0.1:8777>。页面显示任务、公开进度、命令输出和文件变更；日志页不可用不影响消息处理。

日志位于源码旁的 `.execution-logs/`，已加入 `.gitignore`。状态与日志会保留在本机，需由使用者按需要清理。日志脱敏用于减少意外暴露，不应把执行记录当作可直接分享的源码附件。

`status.running` 区分已运行、已退出和无法核验。进程检查被拒绝或工具不可用时返回 `null`，并在 `processCheck` 中说明原因；生命周期命令会停止，不删除锁或启动另一个实例。保存的 `ready` 状态本身不代表进程仍在运行。

```sh
node terminal.mjs             # 持续查看最新任务
node terminal.mjs --once      # 输出当前日志后退出
node terminal.mjs --task <任务UUID>
node monitor.mjs --port 8778  # 单独开启只读日志页
```

已安装 tmux 时可运行 `node terminal.mjs --tmux`，按输出命令只读连接。tmux 使用 `dws-codex-logs` socket；同机多个 checkout 的 latest 查看器会复用同名会话。

## 执行边界

- 保留 `workspace-write` 沙箱；模型轮次按本机配置的 `networkAccess` 控制网络，缺省关闭。该开关不扩大文件可写目录，不支持通过群消息扩大沙箱或替换身份。
- 身份、会话或消息标识缺失时拒绝执行；不将其他同事的普通对话转交本机 Codex。
- 卡片投递结果不明时停止后续写入，不自动补发第二张卡片。
- 图片交付仅由宿主执行，沿用相同身份与已校验目标；投递不明时保留回执，不重发图片。
- 未完成任务不会因重启自动重跑；连接断开不代表已执行的操作会回滚。
- 该实现用于单个实例处理固定群和固定发送者。多个实例应使用独立的配置、状态目录与群入口。

## 开发与验证

```sh
npm test
```

测试覆盖消息来源校验与去重、会话和轮次关联、模型与速度校验、图片边界、卡片生命周期、日志脱敏及只读查看器。测试使用本机临时文件和协议替身，不调用真实模型或发送钉钉消息。

可选的 DWS 请求映射回归：

```sh
DWS_A2UI_DRY_RUN_BIN=/path/to/dws node --test simple-a2ui-card.test.mjs
```

这项检查固定使用 `--dry-run`，核对新卡片的转发参数和合成群目标，不发送消息；未设置该环境变量时跳过。它不能替代客户端显示和转发验收。

个人配置、身份信息、状态、执行日志、下载文件和 `outputs/` 产物均已加入忽略规则。发布前检查实际暂存文件；忽略规则不会移除已经跟踪的文件。

本地历史副本或排查资料可放在 `.local-artifacts/`，该目录同样不会提交；真实配置和认证材料不应放进源码或测试夹具。

| 文件 | 职责 |
| --- | --- |
| `bridge.mjs` / `config.mjs` | 宿主、配置和进程管理 |
| `process-status.mjs` | 宿主进程归属检查与无法核验时的生命周期防护 |
| `policy.mjs` | 来源校验、消息去重键和会话键 |
| `codex-client.mjs` | Codex App Server stdio 协议、线程和轮次 |
| `simple-a2ui-card.mjs` | 单 Markdown 组件 A2UI 卡片的创建、更新和终结 |
| `media.mjs` | 图片下载结果和输入校验 |
| `card-markdown.mjs` | 卡片图片引用解析与本机资源降级显示 |
| `outbound-images.mjs` | 出站图片校验、暂存、发送及回执确认 |
| `execution-log.mjs` | 结构化本机执行记录 |
| `monitor.mjs` / `monitor.html` / `terminal.mjs` | 只读日志查看 |

## 参考

- [DWS CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## 许可

当前未指定开源许可证（`UNLICENSED`）。DWS 和 Codex 作为外部程序调用，本仓库不包含它们的实现，使用时分别遵循其许可和服务条款。
