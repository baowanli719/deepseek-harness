---
description: "gsclaw-server 集成：refresh token 加密落盘的令牌状态机、带 401 重试的认证 HTTP 客户端、ClientConfig 缓存、品牌下发、私有回环路由与日志上传。"
kind: "package-reference"
---

# @deepseek-ai/dsh-gs-server

[English](README.md) | 中文

## 概述

gs-worker 办公 Agent 的 gsclaw-server 客户端：`gsServer` Cordis 服务负责端点解析、认证令牌状态机（access token 仅内存、轮换 refresh token 经 OS 级保护器加密落盘）、带单飞 401 刷新重试的认证 HTTP 客户端、服务端下发的 ClientConfig 缓存、品牌存储、私有 `/api/gs-server/*` 回环路由，以及尽力而为的客户端日志上传。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

`GsAuthUser` 是不含令牌的账户投影（`id`、`username`、`displayName`、`role`）。`GsClientConfig` 是经验证的服务器策略快照，涵盖 Agent 限制、功能、设置页面、权限、技能、模型、应用更新、通知及可选品牌内容。传输字段定义于 `src/contract.ts`；会话和配置事件传递这些投影，不包含访问或刷新令牌。

`src/contract.ts` 中的模型风险协议以 `GsModelRiskStatusRequest` 指定提供方和模型，以 `GsModelRiskView` 返回当前揭示书及可选的存档签署记录，以 `GsModelRiskSignRequest` 提交 revision、确认和归一化签名笔画，并以 `GsModelRiskDownloadRequest`/`GsModelRiskDownloadResponse` 按签署编号查询和传输 base64 PDF。签署不含客户端身份字段；网关读取当前认证账号的姓名和邮箱。

认证提交绑定代次，并与凭据写入串行执行。登出先使正在进行的登录、恢复、刷新与配置拉取失效，再删除本地凭据，并通过 `gs-server/session-ended` 通知消费方。切换端点先结束旧会话。显式端点配置无效时启动失败；仅回环地址及出厂部署端点允许 HTTP；其他端点必须使用 HTTPS。

在 Host 侧组合该插件，提供 `stateDir` 和上报给网关的客户端版本：

```yaml
- name: '@deepseek-ai/dsh-gs-server'
  config:
    stateDir: /var/lib/my-host/gs-server
    clientVersion: 1.0.0
```

`Config` 字段：`stateDir`（必填；保存 `gs-refresh-token.bin`、`gs-endpoint.json`、`gs-brand.json`）、`endpoint`（部署默认端点 `http://192.168.230.108:8151/gsclaw`；持久化覆盖与 `GSCLAW_ENDPOINT` 环境接缝优先于它）、`environment`（显式环境覆盖值）、`clientVersion`（必填）、`clientPlatform`（默认取当前操作系统）、`protector`（refresh token 保护器，见下文）、`routes`（默认 true；把私有路由挂载到 `ctx.webServer`，未组合 webServer 时启动失败）、`restoreOnStart`（默认 false；Desktop 启动判定前恢复已密封的会话，网络失败时保留令牌）、`authRequestTimeoutMs`（默认 15000；认证与 ClientConfig 请求超时，包括启动时恢复登录；模型流仍使用调用方取消信号）、`logUpload` 与 `logLevel`（客户端日志上传开关）、`request`（供宿主适配层与测试使用的 fetch 覆盖）。

消费方声明 `inject = ['gsServer']` 并使用服务契约：`getAccessToken()` 返回内存中的 access token（未登录为 undefined），`fetch(path, init)` 对已解析端点发起认证请求，自动附带 Bearer token 与策略版本头，遇过期 token 的 401 时单飞刷新并重试一次，`getClientConfig()` 返回最新缓存的服务端 ClientConfig。根上下文上以声明合并方式提供事件：`gs-server/session-established`（登录、令牌写入、重启恢复、刷新）、`gs-server/session-expired`（刷新被 401 拒绝）、`gs-server/trust-revoked`（刷新被 403 拒绝）、`gs-server/client-config-changed`（payload 为新的 ClientConfig）。

驱动自有登录界面的宿主直接使用服务方法：登录前握手用 `getMeta`/`getAuthMethods`/`fetchCaptcha`，内置流程用 `loginWithPassword`/`sendEmailCode`/`loginWithEmailCode`，外部签发令牌对（SSO、扫码）经 `adoptTokens` 写入，重启后用 `restoreSession` 恢复，另有 `logout`、`sessionView`、`brandView`、`refreshClientConfig` 与 `setEndpointOverride`/`clearEndpointOverride`。`modelRiskStatus`/`modelRiskSign`/`modelRiskDownload` 代理非可信模型风险揭示流程：签署要求查询、手写签名确认与已签署 PDF 下载。启用 `routes` 时，同一套能力经同源回环 HTTP 暴露在 `/api/gs-server/meta`、`/session`、`/brand`、`/captcha`、`/login`、`/email-code`、`/email-login`、`/logout`、`/model-risk/status`、`/model-risk/sign`、`/model-risk/download`；凭证状态绝不离开 Host 进程。

refresh token 是唯一跨重启持久化的凭证。Windows 使用 CurrentUser DPAPI；macOS 使用 AES-GCM，主密钥保存在登录钥匙串中。其他平台拒绝持久化登录，除非宿主通过 `Config.protector` 注入操作系统保护器。子进程经标准输入接收秘密，不通过命令行参数传递。

<a id="understand-the-implementation"></a>
## 理解实现

`endpoint.ts` 校验端点（仅 IP 字面量回环地址、localhost 及出厂部署端点允许明文 HTTP），并按 覆盖 → 环境 → 配置默认 的优先级解析；持久化覆盖在启动时加载一次，`resolve()` 保持同步。`auth.ts` 把所有刷新汇入同一个单飞 Promise，因为服务端把并发刷新视为令牌重放并吊销整个家族；刷新收到 401/403 时清除本地状态并发出对应会话事件。`client.ts` 把旧版 `{ error, message }` 与 `/api/v1` 的 `{ code, message, traceId }` 两种错误信封归一为 `GatewayError`，并强制 1 MiB 响应上限；模型风险揭示的签署/下载调用把上限放宽到 8 MiB 以容纳 base64 PDF。`config.ts` 缓存推送或拉取到的 ClientConfig 并通知订阅者；每次变更同时送达品牌存储与 `client-config-changed` 事件。`brand.ts` 按 服务端推送 → 持久化缓存 → 内置默认 解析。`routes.ts` 只应答同源回环请求（socket、Host 头与 fetch 元数据由 `loopback.ts` 检查）；路由请求体默认上限 16 KiB，签署路由放宽到 1 MiB 以容纳签名轨迹。`log-exporter.ts` 缓冲脱敏后的 Cordis 日志消息，向 `/api/logs/client` 发送有界批次，任何失败都丢弃而不重试。本包没有可供独立观察方校验的自有关系，因此不发布 invariant 伴生模块。

<a id="model-experience"></a>
## 模型体验

无，因为 gsclaw-server 凭证与 ClientConfig 缓存只影响 HTTP 认证，本包不注册提示词、工具或 Session 事件。

#### KV Cache effect

不改变模型请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 桌面登录和更新 UI 由 `apps/desktop` 持有；本包提供不暴露令牌的私有路由。`GET /api/gs-server/app-update` 主动拉取已认证的 `/api/client-config`，只返回 `appUpdate` 字段；拉取失败时返回错误，网关凭证保留在 Host 内。
- Linux 秘密存储暂缓；Linux 必须注入操作系统保护的 `Config.protector`，否则登录失败。macOS 要求登录钥匙串已解锁且可访问。
- `/api/gs-server/skills` 与 `/api/gs-server/local-skills` 路由暂缓，归属 skill 提供者包（线上契约类型与路径常量保留在 `contract.ts`）；本包拥有会话/品牌/认证/更新路由。
- 原生桌面产品文案由 `apps/desktop` 持有；其他消费方读取 `brandView()` 或订阅品牌存储。
- 路由注册在服务初始化时经 `ctx.get('webServer')` 解析，启用 `routes` 的宿主必须先组合 `@deepseek-ai/dsh-host-webserver`；未声明 `inject`，因为路由是可选能力面。
- 日志上传器的诊断出口（`localLog`）默认未接线，队列溢出与丢批提示被丢弃；需要这些诊断的宿主可自行构造 `GsLogExporter`。

<a id="dev-note"></a>
### 开发备注

迁移自 gs-worker 桌面产品（`dsh-plugin-desktop/src/server/gs-*.ts`）；Electron `safeStorage` 依赖变成了 `protector.ts` 中的 `GsRefreshTokenProtector` 接缝。
