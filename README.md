# DWS Codex Bridge

通过 DWS 把钉钉数字员工与本机 Codex App Server 接起来。在指定群中交办任务，本机 Codex 处理后，将进度和答案写回同一张流式卡片。

```text
钉钉群聊 → DWS CLI → Node.js 桥接程序 → Codex App Server
              ↑            进度和结果回群            ↓
              └─────────────────────────────────────┘
```

## 能力与范围

- 校验数字员工身份、发送者开放 ID 和指定群聊，只有配置的本人能触发本机任务。
- 按会话复用 Codex 线程，以消息 ID 去重，追问可以延续上下文。
- 同一卡片显示处理中、公开进度、最终答案或失败原因。
- 支持消息中的图片引用，由 DWS 下载后作为本机图片交给 Codex。
- 提供本机只读日志页和终端查看器。

这是个人电脑上的桥接示例。电脑需保持在线；它使用你已有的项目环境与 Codex 登录。数字员工“服务对象”的可见范围不等于本机 Codex 的触发权限。

## 准备

1. Node.js 22 或更新版本，macOS 或 Linux。后台进程管理使用 POSIX 进程接口，Windows 暂未验证。
2. 已安装并登录的 [DWS CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)，具备数字员工身份、群消息监听、图片下载和流式卡片能力。开发时使用 DWS v1.0.65，其他版本请先核对对应命令。访问企业数据需要相应的企业管理员授权。
3. 已安装、已登录且支持 `app-server --stdio` 的 Codex CLI。
4. 一个用于交办任务的群，以及已发布数字员工对应的可用 DWS profile。profile 的创建方式见 DWS 的[数字员工接入说明](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/blob/main/skills/multi/dingtalk-tag/references/manage-and-connect.md)。

源码仅使用 Node.js 内置模块，无需安装第三方运行依赖。DWS、Codex CLI 及其凭据均由使用者自行准备。

## 快速开始

```sh
cp config.example.json config.json
```

编辑 `config.json`，填写本机可执行文件路径、项目目录、数字员工身份、自己的开放 ID、目标群和当前账号支持的模型配置。模板里的占位符必须替换。

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

## 本机执行日志

桥接启动后尝试提供只读页面：<http://127.0.0.1:8777>。页面显示任务、公开进度、命令输出和文件变更；日志页不可用不影响消息处理。

日志位于源码旁的 `.execution-logs/`，已加入 `.gitignore`。状态与日志会保留在本机，需由使用者按需要清理。日志脱敏用于减少意外暴露，不应把执行记录当作可直接分享的源码附件。

```sh
node terminal.mjs             # 持续查看最新任务
node terminal.mjs --once      # 输出当前日志后退出
node terminal.mjs --task <任务UUID>
node monitor.mjs --port 8778  # 单独开启只读日志页
```

已安装 tmux 时可运行 `node terminal.mjs --tmux`，按输出命令只读连接。tmux 使用 `dws-codex-logs` socket；同机多个 checkout 的 latest 查看器会复用同名会话。

## 执行边界

- 保留 `workspace-write` 沙箱，模型轮次的网络访问关闭，不支持通过群消息扩大沙箱或替换身份。
- 身份、会话或消息标识缺失时拒绝执行；不将其他同事的普通对话转交本机 Codex。
- 卡片投递结果不明时停止后续写入，不自动补发第二张卡片。
- 未完成任务不会因重启自动重跑；连接断开不代表已执行的操作会回滚。
- 该实现用于单个实例处理固定群和固定发送者。多个实例应使用独立的配置、状态目录与群入口。

## 开发与验证

```sh
npm test
```

测试覆盖消息来源校验与去重、会话和轮次关联、模型与速度校验、图片边界、卡片生命周期、日志脱敏及只读查看器。测试使用本机临时文件和协议替身，不调用真实模型或发送钉钉消息。

| 文件 | 职责 |
| --- | --- |
| `bridge.mjs` / `config.mjs` | 宿主、配置和进程管理 |
| `policy.mjs` | 来源校验、消息去重键和会话键 |
| `codex-client.mjs` | Codex App Server stdio 协议、线程和轮次 |
| `streaming-card.mjs` | 流式卡片的创建、更新和终结 |
| `media.mjs` | 图片下载结果和输入校验 |
| `execution-log.mjs` | 结构化本机执行记录 |
| `monitor.mjs` / `monitor.html` / `terminal.mjs` | 只读日志查看 |

## 参考

- [DWS CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)

## 许可

当前未指定开源许可证（`UNLICENSED`）。DWS 和 Codex 作为外部程序调用，本仓库不包含它们的实现，使用时分别遵循其许可和服务条款。
