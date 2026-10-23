---
description: "gs-worker 服务端通知横幅：轮询 gs-server 通知 loopback 路由，在会话内容区顶部展示当前通知，直到过期或读者关闭。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-notice-gs

[English](README.md) | 中文

## 概述

横幅在会话内容区顶部展示服务端当前通知，无论是否打开会话均渲染。它按可配置周期轮询 Host 的 gs-server 通知 loopback 路由；访问令牌始终保留在 Host。可选的 `startAt`/`endAt` ISO 字段限定展示窗口；不可关闭的通知不渲染关闭按钮。关闭状态按浏览器持久化在 localStorage，通知文案或开始时间变化后自动重新展示。轮询失败保留上一条横幅，避免闪烁。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包是 GS 组合的浏览器插件，由 bundle 的 `cordis.patch.yml` 挂载。它在 `conversation.notice` 注册横幅，该槽位在会话视图上方渲染，无论是否选中会话；无活动通知时条目渲染 null。cordis.yml 行中的 `refreshIntervalSeconds` 设置轮询周期（默认 300 秒）；非正数或非有限值会使加载失败。

服务端应答 `{notice: null}` 时隐藏横幅。缺少调度字段时通知立即展示并保持到被移除或关闭；无法解析的调度字段视为不设限，而不是隐藏通知。

<a id="understand-the-implementation"></a>
## 理解实现

根级控制器把最新拉取的视图与读者的关闭指纹保存在同一个快照存储中；横幅订阅该存储，并通过一个以存储快照和当前时间为输入的纯选择器推导可见性。关闭指纹由通知文案与开始时间拼接而成，因此通知被编辑后会重新向已关闭旧通知的读者展示。指纹持久化在一个 localStorage 键下；存储被拒绝时关闭状态仅在当前会话内有效。刷新定时器运行在 cordis effect 中，卸载插件会清除定时器并移除槽位条目。

本包不发布 runtime invariant 伴生包，因为它只渲染浏览器界面，不持有可被独立观察的 runtime 状态关系。

<a id="model-experience"></a>
## 模型体验

无，横幅只在用户与服务端之间传递信息，不改变模型请求。

#### KV 缓存影响

无；本包不改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 关闭状态按浏览器和 profile 隔离：保存在 localStorage 而非服务端账号，读者在一台设备上关闭通知后，其他设备仍会看到。
- 线路类型在本地（`src/client/contract.ts`）按 `@deepseek-ai/dsh-gs-server` 导出面镜像声明，因为该包的编译面仅面向 Host。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

横幅使用仓库的 slot、locale 与快照存储 API，并沿用 ui-model-risk-gs 的 loopback 模式：同源相对路径 fetch（`credentials: 'same-origin'`、`redirect: 'error'`、`cache: 'no-store'`），加本地线路校验器。

</details>
