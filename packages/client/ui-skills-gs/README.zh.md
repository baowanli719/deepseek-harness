---
description: "gs-worker 技能设置页面和本地技能创建。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-skills-gs

[English](README.md) | 中文

## 概述

本页面列出当前账户可用的服务器和本地技能，切换服务器技能启用状态，并在服务器许可时创建本地技能。Host 负责发现、账户隔离的偏好和权限执行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

不可用的服务器技能展示 Host 给出的具体原因：客户端执行尚未迁移、可信模型会话尚未连接，或执行方式不受支持。仅限可信模型的技能同时显示可信模型标签。用户关闭的受支持技能则说明启用后可以调用。未知或旧响应保留通用不可用提示。

本地创建始终展示权限状态。管理员禁用创建时，表单仍显示，控件变灰禁用，并引导联系管理员。未登录账户和权限刷新失败时不能提交表单。

## Build and verify

设置页面由 `lib/client.js` 提供，与 Host 的 `lib/index.js` 分开。局部构建时，在仓库根运行 `pnpm exec tsc -b packages/client/ui-skills-gs`，再在本包运行 `pnpm exec tsdown --config tsdown.config.ts --env.DSH_BUILD_FACE client`。确认生成 `lib/client.js`；仅 Host 构建成功不会更新页面。替换已安装的构建包时，确认浏览器产物包含新的原因字段，并重启客户端检查页面。

<a id="understand-the-implementation"></a>
## 理解实现

客户端通过同源请求读取 Host 管理的内容。

本插件仅展示浏览器界面，没有独立观察的运行时状态关系，因此不发布运行时不变量伴随模块。

<a id="model-experience"></a>
## 模型体验

用户更改技能后，通过 Host 管理的技能偏好和注册表发现间接影响模型。

#### KV 缓存影响

产生的技能目录可能改变后续轮次的模型工具和技能上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 设置页面没有模型会话上下文；仅限可信模型的技能需要在可信私密会话中执行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作背景——点击展开</summary>

无。

</details>
