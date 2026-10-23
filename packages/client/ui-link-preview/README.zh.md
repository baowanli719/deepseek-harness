---
description: "需要认证的来源链接的插件注册与右侧原文阅读页。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-link-preview

[English](README.md) | 中文

## 概述

本插件在共享的右侧原文阅读页中打开应用管理的来源链接。认证专用插件负责识别 URL 并通过 Host 适配器提供内容；浏览器无需持有网关凭证。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

Web 组合包挂载本插件。提供方注入 `linkPreviews`，通过 `ctx.effect` 注册 `{ name, accepts, read }`。注册返回释放函数；重复名称会失败。首个匹配的注册接管点击。未匹配链接保留 Chat 的浏览器偏好，带修饰键的点击保留原生行为。

`accepts(URL)` 同步执行。`read(url, signal)` 返回 `LinkPreviewResult`：`ok` 携带 `{ title, content, truncated }`，其他状态为 `unauthorized`、`forbidden`、`source-mismatch`、`not-found`、`unavailable` 或 `failed`。提供方负责响应校验与认证后的 Host 路由。Host 在附加凭证前独立校验目标 origin 和路径，并拒绝重定向。[GS Skills](../ui-skills-gs/README.zh.md) 是随附提供方。

阅读页通过共享组件排版 Markdown 标题、表格、列表、引用块、引用式链接和脚注；原始 HTML 保持为字面文本。原始文本视图保留完整返回内容，包括格式异常时的原文回退。选中段落后可点击 **引用选中原文**，在对话输入框记住的选区插入原文和带来源链接的标题，不自动发送。提交处理中禁止引用；插入结果通过共享提示条展示。页面提示截断与认证失败，支持重试及侧栏刷新命令，并取消过期读取。提供方名称和 URL 通过临时标签导航传递；阅读页不持久化原文或凭证。主动引用的内容沿用普通草稿和用户消息的生命周期。

<a id="understand-the-implementation"></a>
## 理解实现

`chat/open-link` 在普通导航前把选中的 HTTP(S) URL 交给插件。本插件解析提供方，在来源 Session 中打开阅读页。注册变化使现有阅读页重新读取；已移除的提供方不能发起新读取。

不发布运行时不变量伴随入口：注册和读取状态各有唯一所有者，没有需要协调的独立观察。行为测试覆盖释放与过期异步结果。

<a id="model-experience"></a>
## 模型体验

无，因为读取来源不添加模型上下文，主动引用沿用普通输入框和用户消息路径。

#### KV 缓存影响

仅读取不改变模型请求。已发送的引用进入普通用户消息上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 恢复侧栏布局不会恢复来源导航参数；重启应用后需要重新打开来源链接。
- 阅读页支持 Markdown 和纯文本。提供方需要自行转换 PDF、Office 或其他二进制来源。本插件不授予任意网站的访问权，也不在提供方 Host 适配器之外附加凭证。最终返回 401 后，阅读页提示用户重新登录；登录界面由认证提供方负责。

<a id="dev-note"></a>
### 开发备注

提供方注册表和阅读页仅在浏览器中运行。Host 适配器负责凭证和响应校验。
