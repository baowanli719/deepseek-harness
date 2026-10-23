---
description: "gs-worker 新任务首屏输入框下方的服务端可配置场景快捷入口：在当前草稿中插入配置的 skill 命令，但不自动提交。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-scenarios-gs

[English](README.md) | 中文

## 概述

输入框下方的场景按钮在当前光标或选区插入 skill 命令。服务端可以替换四个客户端默认场景、隐藏单项或隐藏整个列表。插入保留草稿和引用 chip，仅补充必要的相邻空白，恢复编辑器焦点，绝不自动提交。配置轮询失败时保留最近的有效列表。胶囊形按钮组与输入框卡片之间保留明显间距，每个 label 前渲染按 skill 映射的描边图标：`zhidu-knowledge` 用搜索、`gs-research-summary` 用列表笔、`juyuan-data` 用数据库、`miaoxiang-data` 用灵感图标，其余服务端自定义 skill 用通用 skill 图标。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

GS 浏览器组合按名称挂载本插件到 `conversation.composer.shortcuts`，即新任务 hero 首屏输入框下方的 slot；已开始任务底部的 composer 不 dispatch 该 slot，因此按钮只出现在首屏。`refreshIntervalSeconds` 设置轮询周期（默认 300 秒）；非正数或非有限值会使加载失败。按钮遵循 owner 的 `locked` 状态，并在 mousedown 时阻止焦点移动。

路由 `GET api/gs-server/scenario-shortcuts` 返回 `scenarioShortcuts` 字段。字段缺失或为 undefined 时选择四个本地化默认场景：制度库查询→`zhidu-knowledge`、研报分析→`gs-research-summary`、聚源金融数据→`juyuan-data`、东财金融数据→`miaoxiang-data`。null 或 `{enabled:false,...}` 隐藏列表。否则 `items` 提供非空白的稳定 `id` 和显示 `label`，以及匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$` 的 `skill`；`enabled:false` 的项会隐藏。服务端 label 按数据渲染，不做翻译。

<a id="understand-the-implementation"></a>
## 理解实现

`gs-scenarios` ResourceProtocolMap provider 拥有固定地址 `dsh-resource://gs-scenarios/shortcuts`。插件在自身 effect 生命周期内 pin 该地址，因此流在插件启动时打开，并在 hero 快捷入口组件挂载与卸载之间保持存活；返回首屏会直接读取保留值，不会重启请求或闪烁。provider 的首个 `ok` 帧为 `undefined`（四个默认场景），随后通过不暴露 token 的 Host loopback 路由顺序轮询。严格响应校验拒绝畸形外层结构、条目和重复 id。失败帧由资源注册表保留最近一次成功值。组件通过标准 `useResource` 作为额外持有者读取；组件释放不会关闭已 pin 的流。卸载插件会中止在途 fetch 或等待、丢弃晚到结果，并同时移除 provider 与 slot 条目。

点击时，组件捕获当前带版本保护的选区，利用引用 occurrences 和可选的前导 command token，把 detect 坐标的选区两端换算为 clipboard 坐标；每个 chip 在 detect 中占一个字符，在 clipboard 草稿中占完整文本长度。随后只调用 `inputActions.insertText`。左侧相邻字符不是空白时才添加前导空格；右侧没有已有空白时添加一个尾随空格，草稿末尾也不例外，右侧已有空白则不重复添加。只有插入成功后 owner 才重新聚焦编辑器；插入被拒绝时，焦点和内容仍由编辑器管理。

本包不发布 runtime invariant 伴生包，因为它不持有可被独立观察的 runtime 状态关系。

<a id="model-experience"></a>
## 模型体验

### 请求上下文与条件

#### 模型看到的内容

没有直接影响。本包只对未提交草稿调用 `inputActions.insertText`；之后的模型可见命令由普通用户提交路径负责。

#### Token 影响

无直接 Token 影响。本包既不提交消息，也不组装提供商请求。

#### KV 缓存影响

独立。本包不创建、替换或使任何模型请求或缓存前缀失效。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 线路字段在本地（`src/client/contract.ts`）按 `@deepseek-ai/dsh-gs-server` 配置镜像声明，因为该包的编译面仅面向 Host；变更时必须保持两处声明一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

无。

</details>
