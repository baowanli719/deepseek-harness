---
description: "gs-worker 侧边栏与对话欢迎页的品牌内容。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-gs

[English](README.md) | 中文

## 概述

本浏览器插件展示 gs-worker 标志，并经 Host 同源的 `/api/gs-server/brand` 路由读取有效品牌名称和标题。Host 负责解析云端更新、缓存和默认值。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

产品关于页面也通过品牌标志槽展示这个透明标志。

<a id="understand-the-implementation"></a>
## 理解实现

客户端通过同源请求读取 Host 管理的内容。

本插件仅展示浏览器界面，没有独立观察的运行时状态关系，因此不发布运行时不变量伴随模块。

<a id="model-experience"></a>
## 模型体验

无；品牌内容仅展示浏览器界面。

#### KV 缓存影响

无；本包不改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 品牌在内容挂载时读取；云端改变在下次重新加载后可见。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作背景——点击展开</summary>

无。

</details>
