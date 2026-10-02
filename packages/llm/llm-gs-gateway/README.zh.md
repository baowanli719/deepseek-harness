---
description: "gsclaw 模型网关适配器：把每次启动的占位令牌换成真实 gsclaw 访问令牌的 loopback 代理，以及把服务端 ClientConfig 模型热镜像进 llm-pi-ai 的 volatile 配置。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-gs-gateway

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-llm-gs-gateway` 把 gsclaw 组合接入 gsclaw-server 模型网关。一个 127.0.0.1 随机端口代理用每次启动的占位令牌认证适配器，并通过 `gsServer.fetch` 转发——由它附带真实的内存访问令牌并负责 401 刷新重试；会话 id 指向私密会话的请求会带着 `x-gsclaw-sensitive: 1` 审计头转发。镜像器把服务端 ClientConfig 的 `models` 段规划成 `llm-pi-ai` provider 档案和 `agent-default-model` 默认选择，经 settings 服务写入，改动无需重启即可到达运行中的适配器。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

视觉流量始终带有敏感审计头，即使 MCP 子进程没有会话身份。私密会话的外部 MCP 执行由 sensitive-policy 拒绝。CLI 启动 GS 时，若 Desktop 宿主尚未提供回环凭据，则创建该凭据。

在 gsclaw 组合中挂载本插件，同时挂载 `gs-server`（提供 `ctx.gsServer`）、`settings`、一个休眠的 `llm-pi-ai`（不配置任何 provider）和 `agent-default-model`。两个注入服务都是必需的：缺少任何一个，插件都无法加载。

### 配置适配器

每个部署相关的名称和上限都是 Config 字段：

- `providerNamespace`——镜像器独占的休眠 `llm-pi-ai` 挂载的 settings 命名空间（档案条目 id，默认 `llm-pi-ai`）。
- `defaultModelNamespace`——接收服务端默认模型的 `agent-default-model` 挂载的 settings 命名空间（默认 `agent-default-model`）。
- `credentialRef`——镜像档案中每次启动的代理令牌所经引用的凭证名（默认 `DSH_GS_LLM_PROXY_TOKEN`）。
- `maxBodyBytes`——代理接受的最大 chat-completions 请求体（默认 4 MiB）。

### 接入每次启动的令牌

镜像档案只携带凭证*引用*；令牌本身绝不落盘，也不进入 `process.env`。组合把它作为 launch-environment 快照的 `process` 层条目安装到 `credentialRef` 名下——要么在挂载本插件之前（插件会采用该令牌），要么之后用 `gsLlmGatewayLaunchEnvironment(base, ctx.gsLlmGateway.token)` 包装快照。不做此接线时代理仍会运行，但适配器无法解析凭证，请求会因凭证缺失而失败关闭。

### 读取发布的服务

本插件发布 `ctx.gsLlmGateway`，其中包含代理 `origin`、每次启动的 `token`，以及供组合自建代理路由的 `providerBaseUrl(providerId)`。

<a id="understand-the-implementation"></a>
## 理解实现

### loopback 代理

监听器只绑定 127.0.0.1，每个请求都要求 `Authorization: Bearer <boot token>`，只接受落在 provider 路由语法内的 POST `/v1/{providerId}/chat/completions`，并限制请求体大小。转发通过 `gsServer.fetch('/api/v1/llm/{providerId}/v1/chat/completions')` 进行，请求头全部重建——包括占位令牌在内的入站客户端头永远不会泄漏到上游——所有应答（含 SSE）都不经缓冲直接流入客户端响应。代理唯一读取的入站头是镜像档案打开的会话亲和 `x-session-id`：当可选的 `sensitivePolicy` 服务（`@deepseek-ai/dsh-sensitive-policy`）判定该会话为私密时，上游请求携带 `x-gsclaw-sensitive: 1`——头部由判定重建，伪造的入站头既无法假冒也无法卸掉它。令牌过期的处理在 `gsServer.fetch` 内部（单飞刷新，只重试一次）；重试后的 401 原样透传。没有已登录会话时，代理自己回答 401，不触碰上游。销毁插件会关闭监听器并排干空闲连接。

### 模型镜像

`planGsLlmGatewayModels` 把 ClientConfig 的 `models` 段规划为按序排列的 `openai-completions` provider 档案——`baseURL` 指向代理，`apiKeyEnv` 指向凭证引用——以及来自 `defaultPrimary` 的默认选择（回退到第一个可用模型）。每个镜像档案都设置 `compat.sendSessionAffinityHeaders` 并采用 `openrouter` 格式，因此适配器把每个带会话的请求以单个 `x-session-id` 头绑定到其会话 id——这正是代理审计判定读取的事实，且该头只走回环这一跳。不可用的 provider 和模型跳过并给出警告，而不是让镜像失败；`null` 或不可用的段保持本地设置不变。镜像在 Loader 激活完成后（从缓存的 ClientConfig）、`gs-server/session-established` 和 `gs-server/client-config-changed` 时通过 `settings.replace` 写入 `providers`，通过 `settings.mutate` 写入默认选择；内容相同的推送会被指纹跳过。被镜像的命名空间由本插件独占：用户编辑只能存活到下一次推送。

### 为什么是 llm-pi-ai 而不是 llm-deepseek 的 volatile 配置

gsclaw-server 网关说 OpenAI chat completions（`/v1/chat/completions`）；`llm-deepseek` 适配器对其 `baseURL` 说 Anthropic 风格的 Messages 协议，把它的 volatile `baseURL`/`models` 指向网关得不到可用路由。`llm-pi-ai` 适配器已经实现了这次迁移需要的多路由模式——单个 volatile `providers` 字典里按路由配置 `api`/`baseURL`/`apiKeyEnv`/`models`，volatile 提交即热生效——而被替代的桌面产品也正是把同一份服务端规划镜像进同一个适配器。镜像进 `llm-pi-ai` 既保持线路协议正确，又复用受维护的适配器而不是重复造一份，同时延续了既有行为。

<a id="model-experience"></a>
## 模型体验

间接地，通过被镜像的 `llm-pi-ai` provider 档案和默认模型选择发挥作用，其请求由 dsh-llm-pi-ai 端到端负责。

#### KV 缓存影响

本包不增加任何模型可见内容；被转发请求的缓存身份属于适配器和服务端模型规划，一次镜像触发的模型切换只是按适配器自身规则开始新的对话前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓工作

- **代理自身不持有策略闸门**——桌面版代理的 `judgePolicy`（未知会话失败关闭、可信 provider 判定、无头请求的视觉例外）已由 `sensitive-policy` 在 `llm/stream` 处的进程内强制取代，直接调用者无法绕过；本包负责的是审计头——仅在挂载了可选的 `sensitivePolicy` 服务时发出——以及喂给它的会话 id 一跳。
- **会话过期保留上一次镜像的规划**——没有任何事件会清空已镜像的 providers 或默认模型，与被替代的持久设置行为一致；在新会话推送新规划之前，请求会在代理处以 401 失败。
- **镜像依赖 settings 写入路径**——没有 `settings` 的组合（或目标命名空间改名后未在此配置的）无法接收规划；Loader 组合在激活完成后镜像缓存 ClientConfig，写入失败会记录日志；没有 Loader 时，首次写入失败会拒绝挂载。settings 写入会等待所有 Loader fiber，因此在本插件激活期间等待写入会阻塞启动。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

本开发备注是非权威的工作背景：未定方向和给维护者的备注。已发布的行为和已接受的理据见以上各节与包代码。

- 桌面原版会缓冲一份 401 应答来驱动自己的刷新重试；这里刷新契约移入了 `gsServer.fetch`，所以代理透流所有状态码，不持有任何重试状态。
- 镜像通过 `ctx.settings` 写入而不是直接改写设置文档，因为 Loader 的 volatile 提交是 Harness 唯一的实时配置通道；无操作指纹避免了相同推送搅动 settings 修订号。

</details>

**运行时不变量：** 不发布伴随包。代理端口、令牌和被镜像的设置都是本插件自身 fiber 内创建和拆除的持有关系，不存在可能分叉的独立观测。
