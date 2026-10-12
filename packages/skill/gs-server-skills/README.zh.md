---
description: "gs-worker 组合的服务端执行技能桥与管理员管控的本地技能信任——供组合或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-gs-server-skills

[English](README.md) | 中文

服务端执行的技能桥（由 gsclaw-server 执行的 `run_data_query` / `run_mcp_skill` 工具）与管理员管控的本地技能信任：管理员可以按名称 + SHA-256 把本地技能标记为仅可信。

## 概述

本插件在 `ctx.skills` 中列出服务器交付的技能，并经认证的 GS 桥转发数据查询和服务器 MCP 执行。客户端运行时技能包按当前授权拉取，缓存按端点、账户、技能和版本隔离。加载的远程定义说明查询模板或 MCP 工具。实时管理员开关、账户偏好和私密策略控制发现与执行。本地提供方对受管目录和用户 home 技能应用创建权限，以及管理员名称加 SHA-256 的信任限制。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

受控技能每次加载都复核登录、全局与单项技能控制、偏好、会话代次及私密状态，包括已缓存条目。会话结束事件清理远端状态。客户端技能每次加载都经当前授权重新拉取，并缓存到端点与账户隔离的目录；相同名称和版本不能复用另一账户的文件。

在技能注册表、工具注册表与 `@deepseek-ai/dsh-gs-server` 之后挂载（本插件注入 `skills`、`tools` 与 `gsServer`）。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `executeTimeoutMs` | `120000` | 单次服务端技能执行调用的客户端上限 |
| `bundleCacheRoot` | `$DSH_HOME/gs-skills/bundles` | `client` 运行时技能 bundle 的版本化缓存根目录 |
| `localSkillManagedRoot` | `$DSH_HOME/local-skills` | 应用受管的本地技能根目录，最先扫描 |
| `localSkillHomeRoot` | `~/.skills` | 用户home目录的本地技能根目录，其次扫描 |

<a id="what-the-model-gets"></a>
### 模型得到什么

- **目录中的服务端技能。** 下发的 `data-query` / `server-mcp` 技能像本地技能一样列出与加载；加载出的正文以 `## Available query templates (call via run_data_query)` 或 `## Available tools (call via run_mcp_skill)` 一节结尾，按服务端定义渲染，点名模型可用的确切模板/工具与参数形态。
- **客户端技能以目录 bundle 形式提供。** 下发的 `client` 技能像本地技能一样列出与加载；加载出的正文是 bundle 的 `SKILL.md`，其相对资源相对物化缓存目录解析。
- **桥接工具。** 当有效目录持有某运行时类型的可执行技能时，模型会看到该类型的桥接工具，并以技能名加声明的模板/工具名与参数调用它；结果是服务端的文本，服务端截断时附带后缀说明。
- **受门控的技能在标准通道上保持可见但沉默。** 被标记 `trusted-only` 的服务端技能与命中名称+SHA-256 限制的本地技能以不可调用条目列出；它们从不进入标准模型目录、从不加载、也从不经标准桥接调用解析。
- **实时本地权限。** 本地发现会在扫描后检查登录状态和 `allowLocalSkillCreate`；正文加载在读取文件前后都检查这两项。磁盘 I/O 期间撤销权限会拒绝返回结果。配置推送使发现缓存失效，正文加载器也会独立拒绝旧候选。
- **受门控的 trusted-only 通道。** 本插件提供 `gsServerSkillGate` 服务。`@deepseek-ai/dsh-sensitive-policy` 把它挂载进每个私密会话的 Agent 作用域（`mountPrivateLane(agent.ctx)`）；该作用域通道把目录中保留的受门控条目以可调用列出，并在每次定义加载时复核 `sensitivePolicy.isPrivate(sessionId)`。受门控的执行要求调用方会话为私密会话，请求体携带会话 id，并发送 `x-gsclaw-sensitive: 1` 审计头；仅含受门控条目的目录仍会注册桥接工具。没有 `sensitivePolicy` 服务时，该通道绝不解析受门控内容。

### 可观察的成功与失败

偏好服务返回各技能的运行类型及不可调用原因：`runtime-unsupported` 或 `trusted-session-required`（该技能仅在私密的可信模型会话内运行；无会话的设置视图将其报告为不可用）。用户关闭技能与执行支持是独立状态。不支持和 trusted-only 技能仍保留原有执行限制；返回原因不会将其启用。

对不在有效目录中的技能调用桥接工具会失败，报 `skill "<name>" is not an available <runtimeType> skill in the current catalog`。在私密会话之外调用受门控技能会失败，报 `skill "<name>" requires a trusted session and cannot execute in the current session`。`definition_changed` 失败会使目录失效，并提示模型重新加载技能、重构调用。策略类拒绝会使目录失效且不带重试指引。同步或定义拉取失败保留上一次的好目录并报告不完整发现，以便后续轮次重试。

<a id="model-experience"></a>
## 模型体验

### 桥接工具模式

#### 模型看到什么

仅当服务端宣告了匹配的 `skillExecution` 类型且有效目录持有该类型的可执行技能时，模型才会看到生成的 [`run_data_query` 与 `run_mcp_skill` 模式](../../../docs/tool-catalog.zh.md#deepseek-aidsh-gs-server-skills)——保留的受门控 trusted-only 条目也计入，因此仅含受门控条目的目录仍为私密会话保持桥接可见，而逐次调用的私密检查会拒绝其他一切会话；目录清空、会话登出或总开关 `SKILLs` 关闭时，两者都会消失。

#### Token 影响

每个可见桥接工具每次请求的固定模式成本；隐藏时为零。

#### KV 缓存影响

目录保持工具注册期间前缀稳定；可见性翻转会从工具模式起使复用失效。

### 桥接工具结果

#### 模型看到什么

成功的调用渲染服务端拼接的文本块；服务端标记截断时附加 `[The server truncated this result; narrow the parameters if more rows are needed.]`。失败文本点名机器码，并在存在时附带服务端 traceId。

#### Token 影响

结果 token 取决于数据；只有一次可见的已执行调用会增加它们。

#### KV 缓存影响

工具结果追加在可复用请求前缀之后，从不使已有 KV 缓存条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

从 `dsh-plugin-desktop`（gs-worker）的迁移范围：以下通道被刻意裁掉或暂缓。

- **收窄的 `gsServer` 面。** 本包通过 `src/types.ts` 中的结构化 `GsServerBridge`/`GsSkillConfigView` 子集（令牌、认证 fetch、ClientConfig 子集）消费 `ctx.gsServer`，而非完整的 `GsServer` 类；该类可赋值给该子集，测试以 mock 替代。若上游服务契约变化，必须逐字段重新核对这个面。
- **旧版 `/api/skills` 目录回退未迁移。** 没有 `skillExecution` meta 能力的服务器会收到空目录；旧的整目录列举通道被暂缓。`client` 运行时 bundle 通道本身已迁移：对具备能力的服务器，提供方从 `GET /api/skills/:name/files` 拉取 bundle，由 `SkillBundleCache` 校验并安全物化进按版本划分的磁盘缓存，技能从物化目录加载。
- **受门控的 trusted-only 通道已迁移。** 服务端 `trusted-only` 条目保留在目录的 `gated` 列表中，并经 `gsServerSkillGate` 服务在私密会话内释放（见[模型得到什么](#what-the-model-gets)）；会话何时私密由 `@deepseek-ai/dsh-sensitive-policy` 判定。桌面端通道的已接纳修订钉住（`admit-skill`）被刻意放弃：新的策略核心对它是空操作，每次加载与每次执行时的一次纯 `isPrivate` 复核就是约定的闸门。受限本地内容在所有通道上都保持不可调用。
- **显式私密会话入口 UI 未迁移。** 没有已出厂的界面调用 `sensitivePolicy.enterPrivate`；会话只有在可信提供方路由上运行，或由宿主程序化调用核心时才变为私密（记录于 `@deepseek-ai/dsh-sensitive-policy` 的 README）。
- **受控调用时自动切换到可信路由被暂缓。** 桌面端强制执行器会先把走不可信路由的会话切到默认可信路由再挂载通道；这需要一个公开的模型选择 API，而本仓库尚不存在，因此来自非私密会话的受控调用一律直接拒绝。
- **按用户的技能启用/禁用偏好已保留。** 提供方读取旧版 gs-worker 按账户哈希保存的 JSON 偏好，并在发布技能前应用当前账户的开关。
- **安装集上报与评审上传未迁移。** `POST /api/skills/report-installed` 及其评审内容上传流程留在了后面；它们依赖桌面端的设置/审计界面。
- **设置页状态共享更精简。** 旧版 `gsSkillSync` 跟踪器由当前目录和偏好服务替代；本地技能创建与刷新通过 Host 路由提供。
- **本地根目录无实时文件监视。** 桌面提供方的 `fs/observed` 变更订阅被裁掉；本地技能变更在下一次注册表失效（例如服务端配置推送）时被拾取。

**运行时不变量：** 不发布伴生件，因为目录门控与本地信任检查都同步发生在注册表与提供方操作之内；本包不持有任何独立观察可能产生分歧的持久关系。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是非权威的工作背景；已发布行为以上述各节与包代码为准。

迁移自桌面产品的服务端技能与本地技能提供方（dsh-desktop，只读）。刻意的适配：插件经由 `src/types.ts` 的结构化子集消费 `ctx.gsServer`，使测试可以替换 mock；两个本地根目录都是显式 Config 字段，而非启动器解析的路径。

</details>
