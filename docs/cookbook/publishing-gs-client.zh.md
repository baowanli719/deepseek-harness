# 操作指南：发布 GS 客户端更新

[English](publishing-gs-client.md) | 中文

## 摘要

将验证过的 Windows 安装包上传到 HTTPS 文件服务器，再通过 gsclaw-server 发布版本和更新说明。只上传文件不会通知客户端。本指南针对测试部署 `http://192.168.230.108:8151/gsclaw` 和文件服务器 `https://8.138.102.170`；用于其他环境前，先确认目标部署。

## 目录

- [1. 准备发布](#prepare-release)
- [2. 检查当前通知](#inspect-notice)
- [3. 上传并校验安装包](#upload-installer)
- [4. 发布更新通知](#publish-notice)
- [5. 验证发布及故障恢复](#verify-publication)

<a id="prepare-release"></a>

## 1. 准备发布

先完成构建及打包运行时检查。构建和签名方法见[桌面端打包说明](../../apps/desktop/README.zh.md#desktop-packaging)。通知版本必须与安装包的实际产品版本一致，且严格高于已安装客户端版本才会触发更新提示。只修改通知版本不会升级二进制文件，还可能导致反复提示。

通过客户端安装 GS 更新需要通过[原生签名校验](../../apps/desktop/README.zh.md#gs-server-updates)。未签名测试包可以上传并发布手动安装通知；更新说明中必须标明未签名。不要将它描述为已签名的自动更新。宣传依赖后端的功能前，应先部署必要的接口；图片理解使用服务端管理的视觉模型及其专用接口。

使用 PowerShell、`curl.exe` 和已配置的 `litellm-aliyun` SSH 主机获取文件服务器校验值。将 `GS_RELEASE_INSTALLER` 设置为本地安装包路径，将 `GS_UPLOAD_NETRC` 设置为操作人员的上传凭据文件路径，并从目标部署的密钥配置中取得 `RELEASE_API_TOKEN`。上传账号为 `gs-upload`；操作人员的凭据文件惯例位置为 `%USERPROFILE%\.config\gs-worker\upload.netrc`。令牌、密码和凭据文件不得写入 Git、安装包、命令行参数或操作日志。本地初始化账号不是目标部署的发布凭据。

以下命令共用一个 PowerShell 会话。`2.2.0` 仅为示例，应使用下一次发布的实际版本。

```powershell
$ErrorActionPreference = 'Stop'
$BaseUrl = 'http://192.168.230.108:8151/gsclaw'
$FileOrigin = 'https://8.138.102.170'
$Version = '2.2.0'
$Installer = (Resolve-Path -LiteralPath $env:GS_RELEASE_INSTALLER).Path
$UploadNetrc = (Resolve-Path -LiteralPath $env:GS_UPLOAD_NETRC).Path
if (-not $env:RELEASE_API_TOKEN) { throw 'Set the deployment release token.' }
$Filename = [IO.Path]::GetFileName($Installer)
if ($Filename -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$') {
  throw 'Use an ASCII filename with the real version and build identifier.'
}
if ((Get-Item -LiteralPath $Installer).VersionInfo.ProductVersion -ne $Version) {
  throw 'Notice version differs from installer product version.'
}
$Headers = @{ Authorization = "Bearer $env:RELEASE_API_TOKEN" }
$DownloadUrl = "$FileOrigin/downloads/$Filename"
$RecordDir = Join-Path ([IO.Path]::GetTempPath()) ('gs-client-release-' + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $RecordDir | Out-Null
$LocalHash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash
$LocalBytes = (Get-Item -LiteralPath $Installer).Length
```

<a id="inspect-notice"></a>

## 2. 检查当前通知

上传前先读取并保存已有通知，以确认当前环境，并保留用于恢复的上一份配置。发布令牌可用于发布接口认证；接口也支持管理员 JWT。不要输出任何一种凭据。

```powershell
$Before = Invoke-RestMethod -Method Get -Headers $Headers -Uri "$BaseUrl/api/admin/releases/current"
$Before | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $RecordDir 'current-before.json') -Encoding utf8
if ($Before.appUpdate -and [Version]$Version -le [Version]$Before.appUpdate.version) {
  throw 'Build a genuinely newer version before publishing another update.'
}
$Before.appUpdate
```

每次发布使用独立文件名，并检查其公开链接是否已经存在。文件服务器 WebDAV PUT 创建文件时返回 201，替换文件时返回 204。不要覆盖已发布的安装包，因为客户端可能正在下载。只有服务器校验值与预期本地产物一致时，才可复用已有文件；否则应换用其他文件名。

<a id="upload-installer"></a>

## 3. 上传并校验安装包

使用 netrc 凭据文件上传到 `/upload/<filename>`。`--noproxy` 对该主机绕过工作站代理，TLS 证书校验保持启用。下载使用独立的匿名链接 `/downloads/<filename>`。完成上传后才能开始发布通知。

```powershell
curl.exe --noproxy 8.138.102.170 --connect-timeout 15 --max-time 1800 --fail-with-body --silent --show-error --netrc-file $UploadNetrc --upload-file $Installer --output (Join-Path $RecordDir 'upload-response.txt') --write-out 'HTTP %{http_code}; uploaded %{size_upload} bytes' "$FileOrigin/upload/$Filename"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed; inspect remote state before retrying.' }
$RemoteHash = ssh -o BatchMode=yes -o ConnectTimeout=12 litellm-aliyun "sha256sum /opt/gs-downloads/$Filename"
if ($LASTEXITCODE -ne 0) { throw 'Server checksum failed.' }
if (($RemoteHash -split '\s+')[0] -ne $LocalHash) { throw 'Server checksum differs from local installer.' }
$RemoteHash | Set-Content (Join-Path $RecordDir 'server-sha256.txt') -Encoding ascii
curl.exe --noproxy 8.138.102.170 --connect-timeout 15 --max-time 30 --fail --silent --show-error --head --output (Join-Path $RecordDir 'download-head.txt') $DownloadUrl
if ($LASTEXITCODE -ne 0) { throw 'Public download HEAD failed.' }
curl.exe --noproxy 8.138.102.170 --connect-timeout 15 --max-time 30 --fail --silent --show-error --range 0-63 --dump-header (Join-Path $RecordDir 'download-range-headers.txt') --output (Join-Path $RecordDir 'download-range.bin') --write-out 'Range HTTP %{http_code}; bytes %{size_download}' $DownloadUrl
if ($LASTEXITCODE -ne 0) { throw 'Public download Range failed.' }
```

必须确认 SHA-256 一致，HEAD 返回 200 且 `Content-Length` 等于 `$LocalBytes`、`Accept-Ranges: bytes`，Range 返回 206 且 `Content-Range: bytes 0-63/<total bytes>`。下载的 64 字节必须与本地安装包的开头一致。链接必须无须凭据即可访问，且不能重定向。任一检查失败都应停止发布。

文件服务器将公开安装包存放在 `/opt/gs-downloads/`。另一种方式是使用 gsclaw-server 的 `PUT /api/admin/releases/packages/windowsX64/<filename>`，以原始二进制请求体和发布凭据上传；接口返回产物大小、SHA-256 和下载路径。其反向代理必须允许安装包对应的请求体大小。当前部署应使用验证过的 HTTPS 文件服务器链接，避免在发布期间调整代理限制。

<a id="publish-notice"></a>

## 4. 发布更新通知

文件托管校验通过后才能发布。`POST /api/admin/releases/publish` 替换全局 `appUpdate` 通知，包括各平台下载映射。只包含已提供所声明版本安装包的平台：将旧版 macOS 或 UOS 安装包保留在新版本下会错误地宣告升级。服务端其他配置保持不变。

将 JSON 写入 UTF-8 文件并发送文件字节，确保中文更新说明原样到达服务器。只有需要等到指定的 ISO 8601 时间才开放下载时，才设置 `availableFrom`。未来开放时间允许先通知、后下载。配置 `downloadWindow` 时，它限制桌面客户端内的下载，包括手动确认的下载；它不限制文件服务器的匿名链接。立即发布 Windows 更新的最小请求如下：

```powershell
$Body = @{ appUpdate = @{
  version = $Version
  notes = @('Describe the user-visible changes and any test-package limitations.')
  downloads = @{ windowsX64 = $DownloadUrl }
} }
$ReleaseFile = Join-Path $RecordDir 'release.json'
[IO.File]::WriteAllText($ReleaseFile, ($Body | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
$Current = Invoke-RestMethod -Method Get -Headers $Headers -Uri "$BaseUrl/api/admin/releases/current"
if (($Current | ConvertTo-Json -Depth 8 -Compress) -cne ($Before | ConvertTo-Json -Depth 8 -Compress)) {
  throw 'Another operator changed the notice; reconcile before publishing.'
}
$Published = Invoke-RestMethod -Method Post -Headers $Headers -Uri "$BaseUrl/api/admin/releases/publish" -ContentType 'application/json; charset=utf-8' -Body ([IO.File]::ReadAllBytes($ReleaseFile))
$Published | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $RecordDir 'publish-response.json') -Encoding utf8
```

将上传响应、本地及服务器校验值、HTTP 校验结果、上一份通知、提交的 JSON 和发布响应一并保存。上传成功不等于发布成功；通知通过已认证的客户端配置生效。

<a id="verify-publication"></a>

## 5. 验证发布及故障恢复

回读通知，将版本、下载链接、平台映射和更新说明与提交的 JSON 对比。仅有 POST 成功响应，还不能确认客户端会收到预期通知。

```powershell
$After = Invoke-RestMethod -Method Get -Headers $Headers -Uri "$BaseUrl/api/admin/releases/current"
if ($After.appUpdate.version -ne $Version -or $After.appUpdate.downloads.windowsX64 -ne $DownloadUrl) {
  throw 'Published version or URL differs from the requested release.'
}
if (@($After.appUpdate.downloads.PSObject.Properties).Count -ne 1) {
  throw 'Unexpected platforms in the Windows-only notice.'
}
if ([string]::Join("`n", @($After.appUpdate.notes)) -cne [string]::Join("`n", @($Body.appUpdate.notes))) {
  throw 'Published notes differ from the submitted UTF-8 text.'
}
$After | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $RecordDir 'current-after.json') -Encoding utf8
$After.appUpdate
```

已登录的 Windows 客户端使用启动、窗口聚焦、手动及定时更新检查；登录和服务端配置刷新也会触发检查。当前版本及更高版本的客户端不会为同一发布收到升级提示。`downloads` 中未包含的平台不会收到该平台的升级。轮询时机、通知去重、开放时间和签名要求见 [GS 更新行为](../../apps/desktop/README.zh.md#gs-server-updates)。应在符合条件的测试客户端上确认通知后，才能宣称已验证界面。

认证返回 401 时，应取得目标环境的发布令牌，不要反复尝试本地初始化密码。上传或发布超时后，应先检查公开文件和 `current`，再决定是否重试。如果 POST 已成功但响应丢失，回读一致即可确认完成。如果回读不一致，应先核对当前通知，再进行下一次写入。恢复上一份通知只能通过已获授权的发布操作进行；修改通知不能降级已经安装的客户端。保留旧安装包，使已有下载链接继续有效。

## 开发说明

Windows 2.2.0 测试安装包已于 2026-10-11 上传并回读通知。其大小为 304,914,491 字节，本地与服务器 SHA-256 一致，匿名 HEAD 返回 200，Range 返回 206 且开头字节一致。打包运行时、原生 Sharp、视觉插件加载、构建身份及输入框控件隐藏检查通过。发布验证未启动已登录客户端，也未验证在线视觉后端。这些记录针对该测试产物，不代表已完成签名生产版本验收。
