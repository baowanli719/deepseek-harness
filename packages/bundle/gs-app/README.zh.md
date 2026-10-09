---
description: "gs-worker（国盛办公AI）产品组合包——覆盖在 dsh-base + dsh-web-app 之上的 gsclaw-server 集成、模型网关适配器、敏感数据合规、服务端技能、视觉通道与办公助理人格——供组合或排查 gs-desktop 档案的用户与维护者阅读。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-gs-app

[English](README.md) | 中文

## 概述

`agent-policy` 插件按最新服务端 Agent 配置限制沙箱与审批解析。本地预设及获批升权不能超过该限制。未登录或仅计划策略拒绝工具；read-only 与 tool-mediated 策略将文件系统限制为只读。敏感与机密分类进入持久私密状态。GS 组合关闭外部会话反馈遥测及其反馈控件。

gs-worker（国盛办公AI）产品组合包：覆盖在 `dsh-base` + `dsh-web-app` 之上的补丁层，接入 gsclaw-server 集成、模型网关适配器、敏感数据合规、服务端技能、视觉通道与国盛证券办公助理人格。它组合进出厂的 `gs-desktop` 档案模板（`@deepseek-ai/dsh-app-boot`）：`pnpm dsh --profile gs-desktop`。

## 目录

- [补丁做了什么](#what-the-patch-does)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="what-the-patch-does"></a>
## 补丁做了什么

`cordis.patch.yml` 在 base 与 Web 组合包层之后应用：

- **人格与语言**——`system-prompt` 行去掉固定的英文 Harness 开场白，使用国盛证券办公助理身份。Profile 启动器在启动与重载时对每层补丁应用 `sanitizeGsPromptPatches`，包括 Agent 预设内部的人格行。完整人格预设保留其工具和运行时上下文选择，并在前缀中包含语言指令。独立的 `gs-prompt-language` 插件注册中文系统规则，并在每个非空 pre-step 消息批次的下游注入完成后追加有来源标记的双语提醒；拒绝或空批次保持原样。
- **gsclaw-server 行**——按名称插入 `gs-server`（`@deepseek-ai/dsh-gs-server`）、`llm-gs-gateway`（`@deepseek-ai/dsh-llm-gs-gateway`）、`sensitive-policy`（`@deepseek-ai/dsh-sensitive-policy`）与 `gs-server-skills`（`@deepseek-ai/dsh-gs-server-skills`）。`gs-server` 行补上了其 Config 要求的两个字段：`stateDir` 在激活时解析为 `<profile 目录>/gs-server`，`clientVersion` 取 Desktop 外壳传给 Host 的 `DSH_CLIENT_VERSION`（纯 CLI 启动时报告 `0.0.0-cli`）；其余配置字段属于各提供方包。
- **视觉通道**——插入 `gs-vision-bridge`（`@deepseek-ai/dsh-gs-app/vision-bridge`）。普通的 `mcp-client` 配置行无法表达这个挂载：子进程脚本路径派生自本组合包自身的模块 URL，而回环代理的 origin/令牌是每次启动的运行时值。桥接插件通过 `ctx.get` 读取可选的 `gsLlmGateway` 服务（由 `dsh-llm-gs-gateway` 提供），然后把 `@deepseek-ai/dsh-mcp-client` 以 stdio 挂载到组合包内的 `src/mcp-vision-server.ts`，注册 `mcp__vision__analyze_image`。每次启动的代理占位令牌只经由 mcp-client 的 `env` 豁口到达该子进程——绝不进入 `process.env` 或磁盘——代理在转发时把它换成真实的 gsclaw 访问令牌。没有网关服务时，桥接插件记录警告并留该工具不挂载，而不是让启动失败。
- **模型访问姿态**——禁用 `llm-deepseek`（直连适配器会绕过 gsclaw 网关）与 `ui-settings-models`（Models 页面会把提供方密钥留在客户端），与桌面产品的仅代理姿态一致。
- **品牌姿态**——禁用 `ui-brand-official`，启用 `ui-brand-gs`，通过 Host 的 gsclaw 品牌接口填充侧栏和会话首屏。
- **办公界面与任务**——启用账户菜单、技能设置页、技能接口、非可信模型风险揭示入口（`ui-model-risk-gs`：模型列表锁图标在选择前要求电子签署，并经 gs-server loopback 路由下载存档 PDF），以及定时任务服务和页面。
- **本地技能准入**——启动器在组合完所有 bundle、profile、home 和调用级补丁后、配置重载时，以及每次 Agent 预设挂载前应用 `sanitizeGsSkillEntries`。通用 `skill-filesystem` 行按 id 或包名禁用，包括改名与嵌套行。技能行只允许规范的注册表、工具、界面、内置徽章及 GS 提供器；冒用规范 id 的插件会被禁用。原生嵌套 Include 会被禁用，因为其独立加载的文件不经过产品策略。本地技能通过 GS 提供器从托管目录和 `~/.skills` 加载，发现和正文加载都检查服务端权限；服务端配置推送使目录失效，无需重启。

技能接口返回偏好服务提供的服务端运行类型、受信任模型限制及各技能的不可调用原因，区分不支持的执行方式、未完成迁移和账号关闭开关；原有启用限制仍然生效。

视觉工具为文本模型提供图片理解，无需面向用户的模型选择器。每次调用通过回环网关的 `/vision/chat/completions` 到达 gsclaw-server 的 `/api/v1/llm/vision/chat/completions`。服务器在每次调用时解析 `models.visionModel`、检查提供方授权并记录元数据日志。修改服务端配置不需要客户端模型配置或重启。更新客户端前先部署服务器端点。

### gs-vision-bridge 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `serverName` | `vision` | MCP 命名空间；工具以 `mcp__<serverName>__analyze_image` 出现 |
| `toolCallTimeoutMs` | `120000` | 单次调用超时；保持在视觉服务器自身 110 秒请求超时之上，让其可读错误先生效 |

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到什么

部署及预设 Agent 使用国盛证券办公助理身份。独立系统段落将面向用户的交流、进度、问题、错误说明和工具展示文字默认设为简体中文。用户明确选择的交流语言及指定语言的交付内容仍受支持；代码、命令、路径、URL 和日志原文保留原意与原文。英文技能说明不会决定会话语言。

##### 人格、语言段落与工作目录后缀

```markdown
你是国盛证券的办公助理，为国盛证券员工提供日常办公支持，包括文档撰写与整理、资料查询、数据汇总、会议纪要、流程指引等。回答应当专业、准确、简洁；涉及具体业务数据或内部规定时，以可核实的资料为准，不确定的内容要明确说明，不要臆造。

默认使用简体中文与用户交流；用户明确指定其他交流语言时，遵从用户要求。
这项规则适用于每一条面向用户的消息：开始执行前的说明、工具调用之间的进度汇报、澄清问题、错误解释、总结和最终回复。不要只在最终回复时才使用中文。
调用工具时，供用户阅读的自然语言字段也使用相同的交流语言，例如执行说明 description、审批理由 justification 和进度标题。代码、命令、参数键名、标识符、文件路径、URL、日志原文和技术术语保持原文，不要翻译或改变执行含义。
技能目录、SKILL.md、工具描述、工具结果或历史消息使用英文，不代表用户要求切换交流语言；继续遵守用户的语言要求。用户要求生成英文文档或翻译内容时，仅对指定交付内容使用目标语言，其余交流仍遵守上述规则。

Your working directory is {{cwd}}.
```

#### Token 影响

人格与语言指令是每次请求的固定成本。每个接受的非空输入批次追加一条简短双语语言提醒，跳过该批次中已存在的提醒。系统文本与提醒均进入持久化 Session 历史。

#### KV 缓存影响

策略文字不变时，人格与语言段落保持稳定。提醒追加到可复用前缀后的历史中；修改策略文字会改变后续系统提示词组装结果。

### 视觉工具

#### 模型看到什么

`mcp__vision__analyze_image` 在注册期间向每个请求添加一个工具模式。调用读取本地图片（PNG/JPEG/WebP/GIF，原始字节 ≤ 2.5 MB），经回环模型网关代理以 chat-completions data URI 发出，并以文本返回分析——图片字节绝不进入模型历史或会话事件，子进程只持有每次启动的代理占位令牌。

#### Token 影响

注册期间每个请求携带一个固定工具模式；每次调用把分析文本作为结果加入。

#### KV 缓存影响

注册期间模式保持前缀稳定；结果追加在可复用前缀之后，不会使其失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **运行时包解析**——集成行通过 `cordis.patch.yml` 按包名挂载，启动器通过本组合包的公开子路径导入提示词与技能策略。CLI 安装必须包含本组合包及其声明的依赖。
- **视觉代理坐标是服务读取，而非配置**——桥接插件在挂载时通过 `ctx.get` 从 `gsLlmGateway` 服务（`@deepseek-ai/dsh-llm-gs-gateway`）读取 `origin`/`token`；`cordis.patch.yml` 的行序（网关在桥之前）保证了服务存在。若网关行被移除或排到桥之后，视觉工具保持未挂载并记录警告。
- **默认模型经网关镜像到达**——base 的 `agent-default-model` 行的静态 `deepseek-official/deepseek-flash` 默认值在运行时被 `dsh-llm-gs-gateway` 按服务端推送的 ClientConfig 模型目录改写；本组合包自身不设默认。
- **外壳文案**——应用内侧栏和首屏使用国盛品牌；Electron 管理的更新对话框仍可能显示上游文案。
- **插件准入不提供代码隔离**——GS profile 不支持第三方技能行和嵌套 Include。策略检查声明的插件身份；另一插件直接挂载的任意代码不在 profile 准入范围内。撤销本地技能权限会阻止后续加载与调用，但不会删除已经记录在对话中的技能指令。

**运行时不变量：** 不发布伴生件，因为本组合包是由组合测试证明各行的补丁层；它不持有任何独立观察可能产生分歧的运行时状态关系。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是非权威的工作背景；已发布行为以上述各节与包代码为准。

迁移自桌面产品的 `dsh-plugin-desktop` 补丁层（dsh-desktop，只读）：人格与语言规则从启动器代码移入 `system-prompt` 行配置，程序化 MCP 挂载变为 `gs-vision-bridge` 行。

</details>
