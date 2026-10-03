# gs-worker 需求与修改记录：2.1.1-test.20261002.3

[English](requirements-and-changes.md) | 中文

## 概要

本文按版本记录 2026-10-03 复核的 GS 桌面项目需求、集成修改及安全修复，汇总用户提出的项目审核和发布要求，以及源码已经交付的 GS 行为。这是交付记录，不代表业务审批或生产安全认证。此前的本机测试安装包生成于本文安全修复之前。

## 目录

- [版本与范围](#version-and-scope)
- [需求与交付](#requirements-and-delivery)
- [分模块修改](#changes-by-area)
- [安全修复](#security-corrections)
- [验证记录](#verification-record)
- [交付条件](#delivery-conditions)

-----

<a id="version-and-scope"></a>
## 版本与范围

本机成功的 Windows 打包记录提供本文及分支使用的完整版本号。产品版本与运行时版本由不同文件维护。

| 项目 | 记录值 | 证据 |
| --- | --- | --- |
| 产品 | `gs-worker` / 国盛办公AI，profile 为 `gs-desktop` | [GS 组合](../../../../packages/bundle/gs-app/README.zh.md) |
| GS 产品版本 | `2.1.1` | [产品清单](../../../../apps/desktop/brand/gs/product.json) |
| 测试打包版本 | `2.1.1-test.20261002.3` | 本机打包于 2026-10-02 21:59:58（Asia/Shanghai）成功完成 |
| 运行时版本 | `0.2.0-rc.2` | [桌面包清单](../../../../apps/desktop/package.json) |
| 版本分支 | `v2.1.1-test.20261002.3` | 按完整打包版本命名 |
| 此前审核分支 | `fix/gs-security-hardening-20261002` | GS 集成及已复核的安全修复 |
| 此前安装包 | `gs-worker-2.1.1-test.20261002.3-win-x64-unsigned.exe` | 本机未签名 Windows x64 产物；打包运行时冒烟阶段成功 |

本机运行元数据注明 `win-x64`、`unsigned: true` 及非干净工作区。安装包生成于后续安全修复之前。当前分支包含这些已复核的修复和本文档；创建分支不会重新构建或签名该安装包。本次任务不修改版本清单、不上传安装包，也不创建发布标签。

<a id="requirements-and-delivery"></a>
## 需求与交付

下表归纳已实现的 GS 项目范围，以及用户提出的审核、修复、验证、发布和文档整理要求。可观察检查给出部署验收依据，不额外推断未提供的业务需求。

| 编号 | 需求及已交付行为 | 可观察检查 / 维护来源 |
| --- | --- | --- |
| R01 | 使用 GS 产品品牌及国盛证券办公助理身份；面向用户的交流默认使用简体中文，并遵从明确的语言选择。 | 产品图标、登录页、侧栏及对话身份；[GS 组合包](../../../../packages/bundle/gs-app/README.zh.md)。 |
| R02 | 按 gsclaw-server 宣告的登录方式认证；恢复加密 refresh 凭据；退出或账户会话终止后返回登录页。 | 登录、重启、退出及会话过期流程；[GS 服务器客户端](../../../../packages/api/gs-server/README.zh.md)。 |
| R03 | 真实 access token 和模型提供方凭据由 Host/服务器持有；模型和视觉请求经 GS 网关转发。 | Renderer 接收账户视图；认证模型请求使用当前服务端配置；[模型网关](../../../../packages/llm/llm-gs-gateway/README.zh.md)。 |
| R04 | 列出服务端/本地技能及不可用原因，控制服务端技能启用状态，仅在服务端允许时创建本地技能。 | 技能设置及未授权加载的拒绝结果；[技能提供器](../../../../packages/skill/gs-server-skills/README.zh.md)。 |
| R05 | 提供账户/设置导航、GS 品牌及定时任务服务和页面。 | 账户入口、技能页面、侧栏/首屏及定时任务入口；[GS 组合配置](../../../../packages/bundle/gs-app/cordis.patch.yml)。 |
| R06 | 中文提示词策略覆盖 profile 补丁、预设、重载及已接受输入批次；输入触发行为与编辑器状态一致。 | 有归属标记的语言提醒及输入/引用提交回归；[提示词策略](../../../../packages/bundle/gs-app/src/prompt-policy.ts)。 |
| R07 | GS 桌面产品单独维护版本，使用品牌安装器素材、安装范围/旧版安装处理及自身更新渠道。 | 版本解析器、安装/打包测试及打包元数据；[桌面打包说明](../../../../apps/desktop/README.zh.md)。 |
| R08 | 落实私密会话外发规则、服务端 Agent 限制、凭据保护及认证更新安装；修复发现的问题并发布已验证源码。 | 下文安全和回归证据；[安全迁移指南](../../../upgrade-guide/v0.2.0-rc.2/gs-security-policy/guide.zh.md)。 |

<a id="changes-by-area"></a>
## 分模块修改

集成修改覆盖桌面外壳、Host 服务、GS 组合及客户端界面。以下维护来源说明配置和确切行为，本文不重复其 API 目录。

| 范围 | 修改内容 | 维护来源 |
| --- | --- | --- |
| 桌面与安装器 | 新增 GS 登录 IPC/窗口、品牌素材、可配置产品/产物标识、GS profile/版本选择、安装范围与旧版卸载处理，以及 GS 更新验签。 | [桌面应用](../../../../apps/desktop/README.zh.md) |
| 账户与网关 | 新增认证代次、加密凭据持久化、服务端配置/品牌接口、凭据脱敏的日志上报、模型目录镜像及视觉路由。 | [GS 服务器客户端](../../../../packages/api/gs-server/README.zh.md)、[网关](../../../../packages/llm/llm-gs-gateway/README.zh.md) |
| 会话与执行 | 新增持久化私密策略、恢复投影、工具外发限制，以及作用于沙箱/审批解析的服务端限制。 | [私密策略](../../../../packages/guard/sensitive-policy/README.zh.md)、[Agent 限制](../../../../packages/bundle/gs-app/src/agent-policy.ts) |
| 技能与客户端 | 新增服务端执行桥接、按账户隔离的偏好/缓存、受控本地技能、账户/品牌/技能界面及对话/输入接线。 | [技能](../../../../packages/skill/gs-server-skills/README.zh.md)、[账户界面](../../../../packages/client/ui-account-gs/README.zh.md)、[技能界面](../../../../packages/client/ui-skills-gs/README.zh.md) |
| 构建与仓库检查 | 更新依赖、源码映射、profile fixture、生成目录、持久化确认记录，以及兼容 Windows 的文件系统/NodeNext 测试 fixture。 | [持久化记录](../../../persistence-changes/2026-10-02-gs-private-policy.zh.md)、[测试策略](../../../testing.zh.md) |

<a id="security-corrections"></a>
## 安全修复

初始审核发现 8 项 P1 和 2 项 P2 安全问题。已复核源码通过下列执行约束修复这些问题。优先级表示原始发现，不表示本文仍留有这些漏洞。

| 编号 / 原始优先级 | 问题 | 已复核修复 |
| --- | --- | --- |
| S01 / P1 | 安装器未校验真实性。 | HTTPS 下载且拒绝重定向；下载后和安装前检查原生签名及当前安装应用的发布者身份。 |
| S02 / P1 | 非回环明文传输及基于域名的私网判定暴露凭据。 | 仅精确 localhost/字面量回环地址允许 HTTP，其余要求 HTTPS；显式无效配置阻止启动，认证请求拒绝重定向。 |
| S03 / P1 | GS 继承外部会话反馈遥测。 | 在 GS 组合中关闭外部会话遥测及反馈界面/命令。 |
| S04 / P1 | 部分私密会话保留外发工具，或无法强化隐私策略。 | 所有进入原因使用同一单调私密策略；执行时拒绝配置的外发工具及所有外部 MCP 工具。 |
| S05 / P1 | 重启后丢失私密分类。 | 持久化 `sensitive/policy`，通过 Session 投影恢复，并在受保护操作前刷写转换；临时状态不得降级已恢复隐私。 |
| S06 / P1 | 视觉请求缺少敏感会话归属。 | 转发视觉请求即使缺少会话标识也标记为敏感；私密会话同时拒绝外部视觉 MCP 工具。 |
| S07 / P1 | 服务端 Agent 安全配置未约束执行。 | 限制沙箱和审批解析，无认证策略或 plan 模式时拒绝工具，对 sensitive/confidential 数据分类进入持久化私密状态。 |
| S08 / P1 | 延迟的登录/刷新响应可能恢复已退出账户。 | 立即作废认证代次并串行写入凭据；账户会话终止时清除配置并通知桌面。 |
| S09 / P2 | 已缓存的 trusted-only 技能定义绕过权限撤销检查。 | 每次加载都复核当前账户、功能/逐技能开关、偏好、代次及隐私状态。 |
| S10 / P2 | 磁盘技能缓存可能复用其他账户内容。 | 按规范化端点/账户分区，在复用缓存前获取当前认证文件，并作废旧引用。 |

额外修复包括 CLI 每次启动的回环凭据、退出后返回登录页、跨午夜下载时间窗、macOS login Keychain/AES-GCM 凭据保护，以及将 GS macOS 产物与上游更新 feed 分离。Windows 无法解析的链接会拒绝访问，避免文件系统授权回退到字面路径。

<a id="verification-record"></a>
## 验证记录

源码验证在原生 Windows、Node `24.14.0`、pnpm `11.7.0` 环境完成。下列数量记录已完成的审核运行；相互重叠的定向复测不能累加为不同测试。新增本文档不代表再次构建安装包或正式发布。

| 证据 | 实测结果 |
| --- | --- |
| 宽范围相关回归 | 261 文件 / 8,774 用例：8,713 通过、56 跳过、5 个 Windows fixture 失败；修复相关 fixture 后重新运行所属测试。 |
| 文件系统所属测试复测 | 93 通过 / 9 明确跳过，原因是 Windows 缺少符号链接权限或不具备对应 POSIX 语义。 |
| GS 定向回归 | 27 文件 / 247 用例通过。 |
| 桌面收尾回归 | 7 文件 / 160 用例通过。 |
| 相邻源码/文档维护范围 | 5 文件 / 197 用例通过。 |
| CLI / 视觉定向回归 | 25 个 CLI 用例及 14 个视觉用例通过。 |
| 构建、lint 与声明 | 完整构建及 lint 通过；333 个工作区声明 API 在 NodeNext 下编译通过。 |
| 仓库与文档检查 | 18 项 hygiene、43 项 doc-sync 及模块图新鲜度检查通过。 |
| 构建运行时及 OS 保护 | plain Node 运行编译后的 GS 策略，实际验证文件写入拒绝/允许、私密事件落盘及重开持久化；Windows DPAPI 真实加解密通过。 |
| 凭据扫描与 Git 钩子 | 5 个 URL 凭据样式命中均核对为测试合成样例；正常提交及推送钩子通过。 |

宽范围运行按实际结果保留，不描述为全通过；定向测试覆盖修复后的失败项。本次未进行生产 gsclaw-server 登录或业务数据请求。macOS Keychain、Gatekeeper 和完整打包在适用范围有单元/模拟覆盖，但未在 macOS 实机验证。本文不宣称远端 CI 的结果。

<a id="delivery-conditions"></a>
## 交付条件

部署验证必须使用已复核源码新构建的安装包。旧的未签名测试产物仅作为版本历史证据。

1. 为网关配置操作系统信任的 HTTPS 证书，端点变更后重新认证。按[安全迁移指南](../../../upgrade-guide/v0.2.0-rc.2/gs-security-policy/guide.zh.md)执行。
2. 保留持久化 Session 存储及 GS 策略插件；验证私密分类在重启后保持，read-only/plan 策略拒绝修改。参阅[私密策略维护来源](../../../../packages/guard/sensitive-policy/README.zh.md)。
3. 构建并验证签名发布安装器。Windows 自动更新要求匹配已安装证书且具备时间戳；macOS 要求匹配已安装 Team ID 并通过 Gatekeeper。更换证书需要经批准的完整安装。
4. 在作出平台或部署验收结论前，完成 macOS 原生及生产服务器验证。Linux 必须显式提供 OS 支持的 refresh-token 保护器，不提供明文回退。Host 插件仍属于部署的可信代码范围，见 [GS 组合的限制](../../../../packages/bundle/gs-app/README.zh.md#known-limitations-and-deferred-work)。
