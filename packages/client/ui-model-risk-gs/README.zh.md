---
description: "gs-worker 非可信模型风险揭示：模型列表锁图标通过电子签署对话框授权模型选择，并提供存档 PDF 下载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-risk-gs

[English](README.md) | 中文

## 概述

模型选择列表的非可信模型行右侧显示锁图标；已签署模型显示中性色的开锁图标，可信模型不显示锁。选择未签署模型时先打开服务端下发的风险揭示书，用户阅读全文、勾选确认并手写签名，服务端返回签署编号后才切换模型。取消或签署失败保留原模型。姓名和接收邮箱由服务端从当前登录账号与员工目录读取，客户端不显示输入框，也不提交身份字段。签署后可下载存档 PDF。所有流量经过 Host 的同源 `/api/gs-server/model-risk/*` loopback 路由；访问令牌不进入渲染进程。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包是 GS 组合的浏览器插件，由 bundle 的 `cordis.patch.yml` 挂载。它在 `model.option.accessory` 注册模型行锁图标，并在 `conversation.input.activity` 承载仅在选择时显示的对话框。`modelDirectories.registerSelectionGuard` 在模型选择器及 `/model` 命令提交选择前等待签署结果。

协议使用用户请求的目标模型，原会话模型直到授权成功才改变。模型行每次菜单打开时读取服务端状态，窗口聚焦时重试；模型选择再次读取当前协议与签署状态。

<a id="understand-the-implementation"></a>
## 理解实现

服务端应答 `required: true` 或风险状态请求失败时显示锁图标。失败时保留上次协议、显示状态暂不可用的提示，并在对话框提供重试按钮；重新读取成功前禁止签署。确认可信的路由隐藏入口。未签署的路由使用警示色锁；已有存档签署记录的路由显示中性色锁。签署时携带状态应答中的 revision；revision 冲突时重新拉取当前协议全文并提示重签。手写签名以归一化 [0,1] 坐标笔画上行，由服务端按自身分辨率渲染 PDF。PDF 下载将 base64 解码为 Blob，并通过临时 `a[download]` 锚点触发。

本包不发布 runtime invariant 伴生包，因为它只渲染浏览器界面，不持有可被独立观察的 runtime 状态关系。

<a id="model-experience"></a>
## 模型体验

无，签署对话框只在用户与服务端之间传递信息，不改变模型请求。

#### KV 缓存影响

无；本包不改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 后台账号缺少姓名或员工邮箱时，服务端拒绝签署并提示管理员完善资料。
- 线路类型在本地（`src/client/contract.ts`）按 `@deepseek-ai/dsh-gs-server` 导出面镜像声明，因为该包的编译面仅面向 Host。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景——点击展开</summary>

协议流程使用仓库的 slot、locale 与共享 Modal。姓名、邮箱和邮件收件人由服务端认证账号确定。

</details>
