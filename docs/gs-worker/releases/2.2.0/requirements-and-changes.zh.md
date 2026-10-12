# gs-worker 需求与修改记录：2.2.0

[English](requirements-and-changes.md) | 中文

## 摘要

本记录按版本归档 GS 桌面端 2.2.0 的特性：非可信云端模型须签署电子风险揭示书后方可使用。客户端在模型选择列表的非可信模型行右侧显示锁图标，选择前须阅读并手写签署服务端下发的揭示书，并可下载存档 PDF；服务端保存签署记录并向用户和管理员邮箱分别寄送 PDF。本记录是交付记录，不构成业务审批或生产安全认证。客户端修订安装包与服务端代码配套交付。

## 目录

- [版本与范围](#version-and-scope)
- [需求与交付](#requirements-and-delivery)
- [分区域修改](#changes-by-area)
- [服务端部署配合](#server-deployment-coordination)
- [验证记录](#verification-record)
- [交付条件](#delivery-conditions)

-----

<a id="version-and-scope"></a>
## 版本与范围

产品版本从 2.1.1 升至 2.2.0；内置 Harness 运行时版本不变。

| 项目 | 记录值 | 证据 |
| --- | --- | --- |
| 产品 | `gs-worker` / 国盛办公AI，profile `gs-desktop` | [GS 组合](../../../../packages/bundle/gs-app/README.zh.md) |
| GS 产品版本 | `2.2.0` | [产品清单](../../../../apps/desktop/brand/gs/product.json) |
| 打包版本 | `2.2.0` 未签名 | Windows 修订安装包包含模型列表选择授权流程 |
| 运行时版本 | `0.2.0-rc.2` | [桌面包清单](../../../../apps/desktop/package.json) |

<a id="requirements-and-delivery"></a>
## 需求与交付

| 编号 | 需求与已交付行为 | 可观察检查 / 归属 |
| --- | --- | --- |
| R01 | 在模型选择列表的非可信模型行右侧显示锁图标；确认可信时无锁，请求失败保留暂不可用的锁。 | 模型行锁状态；[model-risk 界面](../../../../packages/client/ui-model-risk-gs/README.zh.md)。 |
| R02 | 选择未签署模型先打开协议全文，勾选确认并手写签名后才切换；取消保留原模型。姓名与邮箱来自后台账号和员工目录，无客户端输入。 | 选择授权、签名请求与服务端身份查询；同上。 |
| R03 | 按协议的精确 revision 签署；服务端报告 revision 变化时重新拉取当前全文并提示重签。 | revision 冲突重试；同上。 |
| R04 | 签署后显示邮件送达状态，并提供存档 PDF 下载。 | 邮件状态文案与 `a[download]` 流程；同上。 |
| R05 | gsclaw 访问令牌不进入渲染进程；揭示书流量经过 Host 同源 `/api/gs-server/model-risk/*` loopback 路由。 | GS server 包中的路由接线；[GS server](../../../../packages/api/gs-server/README.zh.md)。 |
| R06 | 以产品版本 2.2.0 发布该特性。 | 产品清单与打包断言。 |

<a id="changes-by-area"></a>
## 分区域修改

| 区域 | 修改 | 归属 |
| --- | --- | --- |
| 客户端 | 新增 `ui-model-risk-gs` 插件，在 `model.option.accessory` 显示模型行锁图标，在 Host 请求前授权模型选择，并在 `conversation.input.activity` 承载揭示书对话框；采集归一化手写签名、重拉变化的 revision 并下载存档 PDF。 | [model-risk 界面](../../../../packages/client/ui-model-risk-gs/README.zh.md) |
| Host | loopback 路由 `/api/gs-server/model-risk/status`、`/sign`、`/download` 携带内存中的访问令牌代理服务端。 | [GS server](../../../../packages/api/gs-server/README.zh.md) |
| 组合 | GS bundle 挂载 `ui-model-risk-gs` 并声明 workspace 依赖。 | [GS 组合](../../../../packages/bundle/gs-app/cordis.patch.yml) |
| 版本 | GS 产品版本 2.1.1 → 2.2.0；打包断言随清单更新。 | [产品清单](../../../../apps/desktop/brand/gs/product.json) |

<a id="server-deployment-coordination"></a>
## 服务端部署配合

配套的 gsclaw-server 版本负责签署存档、PDF 渲染与邮件投递。部署顺序与限制：

1. 更新 gsclaw-server，安装依赖并执行数据库初始化，创建 `model_risk_consents` 存档表；按既有策略备份该表。既有数据保留。
2. 安装中文字体，并将 `MODEL_RISK_PDF_FONT` 指向字体绝对路径（TTF/OTF；TTC 可另设 `MODEL_RISK_PDF_FONT_FAMILY`）。字体不可用时服务端拒绝签署与放行。
3. 在管理后台配置协议标题、全文和至少一个管理员收件邮箱；SMTP 复用既有邮件配置。发送失败或超时保留已签署记录并标记 `failed`，可后续补发。
4. 2.2.0 客户端与服务端同步发布。旧客户端不能签署，服务端会拦截未签署的非可信模型请求。

服务端按协议标题、正文、Provider、模型 ID、服务地址与协议类型计算 revision；任一变化都须重新签署。仅修改收件人不使既有签名失效。私密会话仍只允许可信模型路由——签署不会放宽敏感数据门禁。签名为电子手写确认，不含数字证书；接收邮箱按当前认证账号查询在职员工目录并写入存档。

<a id="verification-record"></a>
## 验证记录

源码验证在原生 Windows 上执行。

| 证据 | 观察结果 |
| --- | --- |
| 新包单元测试 | 129 项客户端、模型选择与 loopback 针对性测试通过，覆盖模型行锁图标预期、签署后切换、取消、Loader 注册、存档 PDF 下载和请求不含身份字段。服务端身份签署路由 7 项测试通过。 |
| 类型检查 | 仓库类型检查通过，新包已挂入客户端聚合。 |
| 桌面端版本断言 | 打包与版本解析规格按产品版本 2.2.0 通过。 |

未发起真实的 gsclaw-server 签署、PDF 或邮件请求；loopback 路由以桩应答演练。针对真实服务端、数据库、字体和 SMTP 部署的端到端验证属于发布资格工作。

<a id="delivery-conditions"></a>
## 交付条件

1. 使用本源码生成的 2.2.0 修订安装包；早于本记录的安装包不包含该特性。
2. 先部署配套的 gsclaw-server 并完成字体、收件人和 SMTP 配置；旧客户端不能签署。
3. 在大范围推广前，验证真实账号的签署、PDF 下载、两类收件人的邮件送达与失败补发。
