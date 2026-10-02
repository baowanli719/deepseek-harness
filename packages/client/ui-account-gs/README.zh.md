---
description: "gs-worker 侧边栏底部的账户入口。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-account-gs

[English](README.md) | 中文

## 概述

侧边栏底部显示 gsclaw 账户名称，菜单包含设置、技能、关于和退出登录。入口以 -10 优先级覆盖标准桌面账户入口，避免单槽注册冲突。账户信息经 Host 管理的同源路由读取；访问令牌不会进入渲染进程。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

头像和账户名称组成一个可点击行，无独立展开箭头。悬停和菜单展开使用一致的背景反馈；两种侧边栏宽度均保留本地化无障碍名称、菜单语义及键盘焦点轮廓。

技能和关于菜单使用对应的导航图标。关于通过品牌槽展示产品标志、本地化产品信息、办公能力、企业服务归属和客户端构建版本。

<a id="understand-the-implementation"></a>
## 理解实现

客户端通过 Host 路由和界面槽注册提供内容，退出登录后清除账户视图。

本插件仅展示浏览器界面，没有独立观察的运行时状态关系，因此不发布运行时不变量伴随模块。

<a id="model-experience"></a>
## 模型体验

无；账户菜单仅展示浏览器身份与导航。

#### KV 缓存影响

无；本包不改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 账户信息在入口挂载时读取；服务器端身份改变后需要重新加载。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>供维护者参考的工作背景——点击展开</summary>

无。

</details>
