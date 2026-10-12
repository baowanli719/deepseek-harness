---
kind: upgrade-guide
description: "GS profile 除指定 HTTP 部署外限制网关传输方式，并要求持久私密会话限制，以及由已安装应用发布者签名的安装包。"
---

# GS 网关与安全策略

[English](guide.md) | 中文

## 变更

GS profile 默认使用 `http://192.168.230.108:8151/gsclaw`。仅这个确切部署端点、localhost 与 IP 字面量回环地址接受 HTTP；其他端点，包括其他内网网关，必须使用 HTTPS。显式配置无效时启动失败。切换端点结束当前登录，登出使正在进行的认证与配置响应失效。

GS 私密会话保留命令、联网与外部 MCP 工具，包括视觉工具。本地文件权限预设控制执行；“完全权限”允许 Python、子进程和工作区外文件访问，无需修改沙箱 ACL。普通会话保留服务端文件权限上限；未登录与仅计划策略拒绝工具，适用于全部会话。可信模型路由和审计头仍受强制执行，敏感操作前策略转变以 `sensitive/policy` 持久化。外部反馈遥测关闭。技能文件经当前授权重新拉取，按端点与账户分别缓存。

GS 安装包要求 HTTPS 下载、服务端下载窗口，并在下载后、安装前分别进行原生验证。Windows 要求已安装应用的签名证书与时间戳。macOS 要求已安装应用的 Team ID，并通过 Gatekeeper。GS macOS 打包使用自己的服务端更新通道。

## 迁移

1. 在指定可信部署网络中使用 `http://192.168.230.108:8151/gsclaw`；更新仍选用 HTTPS 的 `GSCLAW_ENDPOINT`、`gs-server.config.endpoint` 或持久化的 `gs-endpoint.json` 覆盖。该端点的认证流量未经加密。其他网关须启用 TLS，并使用操作系统信任的证书。切换端点后重新登录，并确认认证元数据与模型请求成功。
2. 保留 GS 组合条目与持久 Session 后端。删除自定义条目覆盖，或设置 `sensitive-policy.config.egressTools: []`、`restrictExternalMcp: false` 以及 `gs-agent-policy.config.privateFullAccess: true`。重启并选择“完全权限”，允许私密会话运行本地 Python、子进程、联网工具及访问工作区外文件。确认重启保留私密状态、不可信模型路由被拒绝，且本地选择只读或服务端仅计划策略时仍拒绝写入。若要恢复原有限制，省略工具覆盖并设置 `privateFullAccess: false`。
3. 构建签名安装包。通过批准的完整安装分发新的 Windows 签名证书；自动更新固定已安装证书。验证无签名或签名不匹配的包在安装前被拒。macOS 保持登录钥匙串可访问，以保护 refresh token。
4. 重新认证，以当前账户获取技能。旧共享技能缓存目录不会被复用。兼容性细节见[私密策略持久化记录](../../../persistence-changes/2026-10-02-gs-private-policy.zh.md)。
