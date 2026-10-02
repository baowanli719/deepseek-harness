---
description: "私密会话的敏感数据合规守护——仅可信模型路由、在执行器拒绝外发工具、由网关盖章的敏感审计头、服务端信任吊销即挂起——供组合或排查此插件的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sensitive-policy

[English](README.md) | 中文

## 概述

本插件将私密会话约束到服务器声明的可信模型路由，并拒绝外发工具，包括外部 MCP 工具。网关为获准的私密请求添加敏感审计头。显式进入、使用可信提供方、服务器数据分类和分叉血缘均可建立私密状态。持久策略事件和仅供 Host 使用的投影在重启后保留单调分类。信任吊销取消存活的私密 Agent，退出登录取消全部存活 Agent。组合中的服务器技能获得受门控的私密通道。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`sessionProjections` 注册仅供 Host 使用的 `sensitive.policy` 单元；从恢复的会话状态读取分类，随后由已提交事件增量更新。组合必须同时提供该投影注册表。

每次提交的转变都会追加 `sensitive/policy`。模型推理或私密工具执行前，插件等待会话存储的持久化检查点；检查点失败会阻止操作。恢复时先重放这些事件，再执行路由与工具限制。登出取消存活 Agent，私密状态跨重启与分叉保留。

将本插件加入同时挂载了 `@deepseek-ai/dsh-gs-server`（信任来源——声明式注入）与工具运行时的组合；两者都随 gs-worker 组合包出厂。此后私密会话无需额外接线即被强制执行。

### 何时选择

当会话可能承载敏感业务数据，且部署方必须证明此类流量绝不离开可信模型路由或外发工具时，选择它。当组合没有 gsclaw-server 集成时——信任来源是 `gsServer`，没有它任何提供方路由都无法被验证为可信——或当私密会话必须保留不受限的外发能力时，避免使用它。

### 设置

按默认值挂载，或覆盖外发清单：

```yaml
- name: '@deepseek-ai/dsh-sensitive-policy'
  # config:
  #   egressTools: [bash, pwsh, web_fetch, web_search]
```

`egressTools`（默认见 [`DEFAULT_EGRESS_TOOLS`](src/index.ts)）列出显式私密会话会失去的外发型工具。条目在限制发生时对照实时注册表解析，因此列出未注册的工具也是合法的；显式传入空列表会解除外发锁 tier，而可信路由强制与审计头仍然生效。审计头的名称（`x-gsclaw-sensitive`）与取值（`1`）是协议常量，不可配置。

### 你将得到

- 一个 `sensitivePolicy` 服务（`SensitivePolicyCore`），保存每个会话的策略状态：`enterPrivate(sessionId)` 将会话锁定为仅可信出口（永不撤销），`stateOf`/`isPrivate` 读取状态，敏感度（`unclassified` → `potential` → `sensitive`）只升不降。
- 在模型调用边界（`llm/stream`）：私密会话在不可信路由上的请求会在适配器运行前被拒，返回终结性的 `session_provider_forbidden` 错误；获准的请求会记录其提供方路由，并由 gsclaw 模型网关代理在其网线请求上盖上 `x-gsclaw-sensitive: 1` 审计头。
- 在工具执行时，所有私密会话都拒绝配置的外发工具及全部外部 `mcp__` 工具，包括视觉工具。作用域限制还隐藏配置的工具；执行守卫覆盖直接调用与 PTC 子派发。
- 当组合了可选的 `gsServerSkillGate` 服务（`@deepseek-ai/dsh-gs-server-skills`）时：每个私密会话的 Agent——无论会话如何变为私密——都会把受门控的 trusted-only 服务端技能通道挂载进其作用域上下文（`agent.ctx`）：对已处于私密的会话在 `agent/created` 时挂载；会话在运行中转为私密时，则在存活 Agent 上即时挂载。挂载按会话幂等，缺少门控服务时为空操作，且作用域注册随 Agent 一并卸载，因此信任吊销导致的取消会连带拆除该通道。
- 在 `gs-server/trust-revoked` 时：所有已有模型流量的私密会话都会被挂起（其存活 Agent 以 `hook` 原因被取消），且不会再去重判可能已过期的缓存。在 `gs-server/client-config-changed` 时：按最新的信任元数据重判每个私密会话记录的提供方，新落入不可信的会话随即挂起。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节说明插件如何把策略状态键到会话、以及每项强制落于何处；可观察行为已在[使用本包](#use-this-package)完整覆盖。

### 设计哲学

- **在产生行为的操作里执行。** 拒绝发生在 `llm/stream` 瀑布与单调的 `tools.guard` 执行闸门内部，而非 UI 过滤或模式省略，因此直接调用与间接调用（PTC 子派发）都无法绕过。`agent/created` 上的作用域 `tools.restrict` 只是修剪可见面；闸门才是强制点。
- **私密会话共享执行限制。** explicit 与 provider-endpoint 原因记录私密状态的来源。两者都强制可信模型路由与外发拒绝；端点原因可升级为 explicit，私密状态永不降级。
- **失败即关闭。** 信任解析把未知提供方、缺失的 models 节、缺失的缓存 ClientConfig 一律视为 `external`。信任吊销会挂起所有已有流量的私密会话，而不是重读可能早于吊销的缓存。
- **只挂载门控，不复制门控。** 本包只负责判定会话何时为私密；受门控通道本身（逐次加载与逐次执行都复核 `sensitivePolicy.isPrivate` 的作用域 Provider）位于 `@deepseek-ai/dsh-gs-server-skills`，经可选的 `gsServerSkillGate` 服务以 `ctx.get` 到达——绝不作为声明式注入——因此未组合该服务的部署行为与此前完全一致。
- **审计头由网关盖章。** 网线发出发生在模型网关代理中，位于本包请求要跨越的一跳 HTTP 的另一侧：镜像的 `llm-pi-ai` 配置打开了 pi-ai 的会话亲和发射，因此每个适配器请求都带着其会话 id 到达回环代理；代理对照本核心（`isPrivate`）重判该会话，并向上游盖上 `x-gsclaw-sensitive: 1`。判定与盖章读的是同一个核心，二者不可能分歧；会话 id 绝不离开回环这一跳。

### 请求如何被判定

一个 `llm/stream` 监听器读取 `options.sessionId`；没有会话身份的请求原样委托。它注册会话、应用端点判定（走在可信路由上的普通会话转为私密）、以单块的 `finish` 错误流拒绝不可信路由上的私密会话（与适配器失败规范化后的形态一致，循环会记录并按常规失败路径路由），否则记录提供方并委托。由于端点判定在派发前落定，网关代理连会话的首个可信路由请求也会审计。

### 挂起如何判定与执行

核心负责判定：`suspendedSessions(isTrusted)` 返回所记录提供方未通过谓词的私密会话，按序排列保证确定性；尚无已观察提供方的私密会话没有可挂起之物。插件负责执行：对被判定会话，在挂载了 `ctx.agents` 时取消其存活 Agent（`{ kind: 'hook' }`）。被挂起的会话保持私密，因此其后续请求会在流边界重新判定。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`name`/`inject`/`Config`/`apply`、`llm/stream` 包装、外发闸门、作用域限制、技能通道挂载、挂起监听 |
| [`src/core.ts`](src/core.ts) | `SensitivePolicyCore` 状态机：单调迁移、订阅、挂起判定；声明 `Context.sensitivePolicy` |
| [`src/trust.ts`](src/trust.ts) | 信任解析（失败即关闭）与审计头协议常量 |
| [`src/types.ts`](src/types.ts) | 会话策略状态与迁移类型；消费侧的 `GsServerSkillGateFace` |
| — | 不发布运行时 invariant 伴生件：强制同步发生在其所属的瀑布与闸门之内，本包不持有任何独立观察可能产生分歧的持久状态关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不足以解答时阅读这些页面。顺序从强制接缝到信任来源，再到守护族。

- [工具子系统参考](../../../docs/subsystems/tools.zh.md) —— 本包借以强制的 `tools.guard` 单调闸门与限制语义。
- [Cordis 入门](../../../docs/cordis-primer.zh.md) —— `llm/stream` 包装背后的瀑布语义。
- [gs-server 客户端](../../api/gs-server/README.zh.md) —— `gsServer` 服务、其 ClientConfig 信任元数据，以及本包消费的 `gs-server/*` 事件。
- [gsclaw 模型网关适配器](../../llm/llm-gs-gateway/README.zh.md) —— 读取本核心私密判定并在网线上盖上审计头的回环代理。
- [guard 族地图](../README.zh.md) —— 同族的守护包。

-----

<a id="model-experience"></a>
## 模型体验

### 条件性工具结果

#### 模型看到什么

本插件不添加提示词或模式。若私密会话调用外发清单中的工具，模型会收到一条错误结果：`Error: tool "<name>" is unavailable in a private session: sensitive-data policy restricts egress-capable tools`；其余结果原样通过。

#### Token 影响

获准的调用零额外 token。一次拒绝只增加一条留存的短小错误结果，并阻止被拒工具的输出进入上下文。

#### KV 缓存影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使已有 KV 缓存条目失效。

### 条件性模型请求

#### 模型看到什么

私密会话在不可信提供方路由上的请求会在派发前被拒，形成终结性的 `session_provider_forbidden` 失败；请求从不抵达提供方，因此模型不会为其产出内容，而是轮到结构化失败浮出水面。

#### Token 影响

被拒的请求向提供方发送零 token；获准的请求与未加守护的组合字节一致（审计头属于模型不可见的传输元数据）。

#### KV 缓存影响

无变化：请求内容不被改动，前缀复用表现与未装本插件时完全一致。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下是 gs-worker 迁移的持久消费缺口，而非任务清单。

- **手动私密会话界面暂缓。** 服务端 `agent.dataClass` 的 `sensitive` 或 `confidential`、使用可信提供方，或宿主调用 `enterPrivate` 均可建立私密状态。出厂界面没有独立的手动开关。
- **服务端技能门控分拆在两个包。** 本包负责把受门控通道挂载进私密 Agent；通道本身与普通会话对受控技能的守卫随 `@deepseek-ai/dsh-gs-server-skills` 出厂。桌面端通道的已接纳修订钉住（`admit-skill`）被刻意放弃：本核心对该转移是空操作，通道在每次加载与每次执行时的一次纯 `isPrivate` 复核就是约定的闸门。
- **受控调用时自动切换到可信路由被暂缓。** 桌面端强制执行器会先把走不可信路由的会话切到默认可信路由再挂载通道；这需要一个公开的 `sessionController.selectModel` 等价物，而本仓库尚不存在，因此来自不可信会话的受控调用一律直接拒绝。
- **`-vision` 孪生信任继承被移除。** 桌面端曾为 vision-router 的 `-vision` 提供方孪生派生信任；该 router 不在本仓库，因此孪生解析在此没有消费者。
- **挂起是协作式的。** 取消会中止存活 Agent 的活动；会话保持私密且后续每个请求都会重新判定，但忽略中止信号的操作不会被硬性杀死。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：尚未决定的开放问题与方向。它明确不具权威性——已发布行为、限制与已接受的 rationale 以上述各节、包代码与所链接文档为准。

核心由插件创建，`gsServer` 为声明式注入；会话策略事件在恢复时重放，新转变在敏感操作前持久化。

</details>
