# Multica 看板

把 Multica 的 issue 看板接进 Paseo。在 Paseo 里直接浏览按状态分列的卡片，切换 Multica profile 与工作区，创建新卡片、拖动卡片改状态，把卡片作为上下文附加到某个 Paseo 会话。

## 它做什么

- 一个侧边栏项目「Multica」：主体是看板（切换本机 Multica profile 与工作区，工作区一排可跳转 Multica 网页；卡片按状态分列展示，可跳转卡片网页），标题行右侧的「运行时接入」按钮切换到安装器视图，「返回看板」可切回。
- 看板交互：每列头部「+」在该列内联新建卡片；卡片左侧「≡」手柄拖动到另一列即修改状态（以半列宽为切换阈值，拖动时目标列高亮）；卡片上不再放改状态的按钮。
- 一个可搜索的附件源：在任意会话的输入框里搜到 Multica 卡片并附加，作为该次提示的上下文。
- 会话结束回写：对已关联的 Paseo 会话，在其回合结束时把结果以评论形式回写到对应卡片（默认关闭，按实例开启）。
- 「运行时接入」视图（安装器，位于同一「Multica」屏内）：把本机 Paseo 作为自定义 Multica 运行时接进去，让 Multica 派发的任务改由 Paseo 执行。

## 如何工作

插件服务端在本机直连 Multica 的 HTTP API（`/api/issues`、`/api/agents`、`/api/issue-statuses` 等），并使用 Multica CLI 的访问令牌鉴权。看板的 profile 列表直接来自本机 Multica CLI：默认 `~/.multica/config.json` 与 `~/.multica/profiles/<名>/config.json`，切换 profile 后工作区列表取自该服务端的 `/api/workspaces`。插件设置里的实例仍用于附件源与会话回写。凭据只在守护进程侧读取，不会出现在界面里。

## 运行时接入（安装器）

「运行时接入」视图（从「Multica」看板顶栏进入）把本机 Paseo 注册成一个自定义 Multica 运行时（走 ACP，协议族默认 `dim`），此后 Multica 派发的卡片任务会由本机 Paseo（经 `paseo-acp-harness`）执行，Paseo 的实时输出会回流为 Multica 的任务消息，Multica 选择的模型也会透传给 Paseo。

接入后：Multica 把卡片派给绑定该运行时的 agent，任务由本机 Paseo 执行；同一卡片续跑时 harness 会**复用同一个 Paseo 工作区/对话**（`session/resume`），而不是每次新建；Multica 选的模型与推理档位、以及（Paseo 侧发起的）工具权限都会透传。

「一键接入」幂等地执行：

1. 在本机 PATH 目录落一个 `paseo-acp-harness` wrapper（优先 `multica` 二进制所在目录）。它指向**随插件分发的单文件 harness**（`vendor/paseo-acp-harness.cjs`），因此装插件即自带该能力，无需另外安装 npm 包。
2. 注册自定义 runtime profile（协议族须为 ACP，**默认 `dim`**）；已存在则复用。
3. 重启 Multica daemon 让 profile 生效（可在设置里关闭，改为手动重启）。
4. 建/复用绑定该 runtime 的 agent。

屏幕会显示每一步的前置检查与结果（CLI/harness 路径、可选目录、profile、runtime、agent 状态）。安装器只做本机操作，凭据沿用 Multica CLI 的配置。

### 已有 hermes profile 的迁移

Multica 的协议族**不可修改**。若此前用 `hermes` 接入（会让同 issue 追回丢失会话），需：新建 `dim` profile → 重启 daemon → 用 `multica agent update <agent> --runtime-id <新 runtime>` 重绑 agent → 删除旧 `hermes` profile。屏幕上的 runtime profile 行会显示当前实际协议族，可据此判断是否已迁移。

配套的维护行为：

- **升级自愈**：插件加载时若发现 wrapper 已存在但指向旧路径（例如插件升级换了安装目录、或 node 路径变化），会自动重写到当前 harness。
- **移除本机接入**：屏幕上的「移除本机接入」删除 PATH 里的 wrapper（只删本插件写的那份；Multica 侧的 runtime/agent 保留）。建议在卸载插件前先点它。
- harness 路径优先级：设置里的 `harnessPath` → 环境变量 `PASEO_MULTICA_HARNESS` → 插件自带的 `vendor/…cjs` → 开发目录的 `dist/index.js`。

### 目标 profile 的选择与新建

- **列出并选择**：屏幕会枚举本机实际的 Multica CLI profile（默认 profile 读 `~/.multica/config.json`，具名 profile 读 `~/.multica/profiles/<name>/config.json`），以可点选的形式展示（含每个 profile 的 `server_url`）。选中的 profile 决定「一键接入」把运行时注册到哪台 Multica server/工作区。
- **新建**：屏幕上的「新建 profile」表单会以**非交互**方式创建具名 profile —— `multica --profile <名> config set server_url/app_url/workspace_id …`，再用 PAT 走 `login --token mul_…`。`token` 可留空（此时会在结果里提示之后补 `multica --profile <名> login`）。新建成功后自动出现在可选列表里。
- 设置里的 `profile` 仍是默认目标（空=默认 profile）；屏幕上的选择是一次性覆盖，用于临时接入另一个 profile。

## 设置

在「设置 → 插件 → Multica 看板」里管理实例，可配置多个：

- `Server URL`：Multica 后端地址，默认 `http://localhost:8080`。
- `Web App URL`：用于「网页」跳转，默认继承自 CLI 配置。
- `工作区 ID / Slug`：留空时继承 CLI 配置并自动解析 slug。
- `CLI 配置路径`：从中继承工作区与令牌，默认 `~/.multica/config.json`。
- `Token`：留空则读取上述配置文件；填写则覆盖。
- `会话结束回写`：开启后，已关联的 Paseo 会话在结束时把结果评论回写卡片。

「运行时接入」区块可配置：`profile`（Multica CLI profile，空=默认；填其它 profile 可把本机 Paseo 接入到另一台 Multica daemon）、`binDir`（wrapper 落点，留空自动探测）、`harnessPath`（harness 入口，留空按开发目录探测或读环境变量 `PASEO_MULTICA_HARNESS`）、`runtimeType`（协议族，默认 `dim`）、`commandName`、`displayName`、`provider`、`agentName`、`restartDaemon`。

留空实例列表时会自动探测本机 Multica CLI 配置作为默认实例。

## 需要注意

- 回写只作用于被显式关联过的 Paseo 会话（通过 `/multica-link`）。
- `Token` 以明文存于 Paseo 的 host 设置文档，适合本机使用；共享或多用户主机上建议留空并改用 Multica CLI 配置文件。