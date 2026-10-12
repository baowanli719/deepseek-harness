# Cookbook: publishing a GS client update

English | [中文](publishing-gs-client.zh.md)

## Summary

Upload a verified Windows installer to the HTTPS file server, then publish its version and notes through gsclaw-server. Uploading a file alone does not notify clients. This tutorial covers the test deployment at `http://192.168.230.108:8151/gsclaw` and the file server at `https://8.138.102.170`; select the intended deployment before using another environment.

## Table of Contents

- [1. Prepare the release](#prepare-release)
- [2. Inspect the current notice](#inspect-notice)
- [3. Upload and verify the installer](#upload-installer)
- [4. Publish the update notice](#publish-notice)
- [5. Verify publication and recover](#verify-publication)

<a id="prepare-release"></a>

## 1. Prepare the release

Start with a completed build and its packaged-runtime checks. Follow the [Desktop packaging instructions](../../apps/desktop/README.md#desktop-packaging) for building and signing. The notice version must equal the installer's actual product version and must be strictly newer than the installed client to trigger an update prompt. Changing only the notice version does not upgrade the binary and can cause repeated prompts.

Windows GS updates require an enterprise-signed release manifest beside the installer; see the [update trust rules](../../apps/desktop/README.md#gs-server-updates). The installer itself may lack Windows Authenticode, but label this distinction in release notes. Older clients require one manual installation of the manifest-verifying client. Deploy required backend interfaces before advertising dependent features.

Use PowerShell, `curl.exe`, and the configured `litellm-aliyun` SSH host for the file-server checksum. Set `GS_RELEASE_INSTALLER` to the local installer path, `GS_UPLOAD_NETRC` to the operator's upload credential file, and `RELEASE_API_TOKEN` from the selected deployment's secret configuration. The upload account is `gs-upload`; the operator credential file is conventionally `%USERPROFILE%\.config\gs-worker\upload.netrc`. Keep tokens, passwords, and credential files out of Git, installers, command-line arguments, and operation logs. A local seed account is not the deployment's release credential.

The commands below share one PowerShell session. The `2.2.6` value is an example; choose the actual version of the next release.

```powershell
$ErrorActionPreference = 'Stop'
$BaseUrl = 'http://192.168.230.108:8151/gsclaw'
$FileOrigin = 'https://8.138.102.170'
$Version = '2.2.6'
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

## 2. Inspect the current notice

Read and save the existing notice before uploading. It identifies the active environment and provides the previous configuration for recovery. The release token authorizes the release endpoints; an administrator JWT is another supported credential. Do not print either credential.

```powershell
$Before = Invoke-RestMethod -Method Get -Headers $Headers -Uri "$BaseUrl/api/admin/releases/current"
$Before | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $RecordDir 'current-before.json') -Encoding utf8
if ($Before.appUpdate -and [Version]$Version -le [Version]$Before.appUpdate.version) {
  throw 'Build a genuinely newer version before publishing another update.'
}
$Before.appUpdate
```

Use a distinct filename for each release and check whether its public URL already exists. The file server's WebDAV PUT returns 201 for creation and 204 for replacement. Do not overwrite a published installer: clients can already be downloading it. Reuse an existing file only after its server checksum matches the intended local artifact; otherwise choose another filename.

<a id="upload-installer"></a>

## 3. Upload and verify the installer

Upload to `/upload/<filename>` with the netrc credential file. `--noproxy` bypasses the workstation proxy for this host; TLS certificate validation remains enabled. Downloads use the separate, anonymous `/downloads/<filename>` URL. The upload completes before publication starts.

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

Require a matching SHA-256, a HEAD response of 200 with `Content-Length` equal to `$LocalBytes` and `Accept-Ranges: bytes`, and a Range response of 206 with `Content-Range: bytes 0-63/<total bytes>`. The 64 downloaded bytes must match the local installer's prefix. The link must work without credentials or redirects. Stop before publishing if any check fails.

If SSH checksum verification is unavailable, download the complete installer from its anonymous HTTPS URL and compare the downloaded size and SHA-256 with the local artifact. HEAD and Range checks alone do not establish a matching installer digest. An SSH connection timeout does not justify overwriting an uploaded file.

The file server stores public installers under `/opt/gs-downloads/`. The alternative gsclaw-server upload is `PUT /api/admin/releases/packages/windowsX64/<filename>` with raw binary content and release authentication; it returns the artifact's size, SHA-256 and download path. Its reverse proxy must accept the installer size. Use the verified HTTPS file-server link for this deployment instead of changing proxy limits during a release.

Create the companion with `corepack pnpm exec tsx apps/desktop/scripts/sign-gs-release.ts --installer <exe> --url <download-url> --version <version> --key-file <private-pem> --expires-at <ISO-time> --out <exe>.release.json`. Run it from the repository root on Windows. The operator owns the Ed25519 PKCS8 private key outside Git and restricts its file access; only its public identity belongs in the client. The tool checks the installer ProductVersion and refuses keys absent from the client. Upload the companion with the same WebDAV credentials to `/upload/<filename>.release.json`, then verify its anonymous `/downloads/<filename>.release.json` response. Upload and verify both files before publishing. Preserve accepted keys in subsequent clients; key replacement requires distributing the next embedded key through a release authorized by an existing key. This deployment has no remote key-revocation service.

<a id="publish-notice"></a>

## 4. Publish the update notice

Publish only after hosting verification. `POST /api/admin/releases/publish` replaces the global `appUpdate` notice, including its platform download map. Include only platforms with installers for the declared version: retaining an older macOS or UOS binary under the new version would advertise the wrong upgrade. Other server configuration remains unchanged.

Every Windows notice includes a recovery instruction and the exact installer download URL. Tell users to quit GS Worker and install into the original directory if upgrading fails or the reopened client still reports the old version. Use the same URL as `downloads.windowsX64`; a missing enterprise manifest must still fail automatic upgrade verification.

Write the JSON to a UTF-8 file and send its bytes so Chinese notes reach the server unchanged. Set `availableFrom` only when downloads must wait until an ISO 8601 time. A future availability time permits a notice before downloading. When configured, `downloadWindow` limits downloads inside the desktop client, including manually confirmed downloads; it does not restrict the anonymous file-server URL. The minimal immediate Windows publication is:

```powershell
$Body = @{ appUpdate = @{
  version = $Version
  notes = @(
    'Describe the user-visible changes and any test-package limitations.',
    '若升级失败，或重新打开客户端后仍提示更新，请退出 GS Worker，下载以下安装包并选择原安装目录完成手动升级。',
    "手动升级下载地址：$DownloadUrl"
  )
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

Keep the upload response, local and server checksums, HTTP verification, previous notice, submitted JSON, and publish response together. Upload success is not release success; publication becomes effective through the authenticated client configuration.

For a notes-only correction, fetch a fresh `current` snapshot, retain the existing version, complete download map, and any availability fields, and change only `appUpdate.notes`. Skip the new-release version-increase guard and the build/upload steps; compare the fresh snapshot again immediately before POST and read the notice back afterward. Do not raise the version or replace either artifact to add a recovery link.

<a id="verify-publication"></a>

## 5. Verify publication and recover

Read the notice back and compare the version, download URL, platform map, and notes with the submitted JSON. A successful POST alone does not establish that clients receive the intended notice.

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

A signed-in Windows client uses startup, window-focus, manual, and periodic update checks; login and refreshed server configuration also trigger a check. A current or newer client does not receive an upgrade prompt for the same release. Clients on platforms omitted from `downloads` do not receive that platform's upgrade. Follow the [GS update behavior](../../apps/desktop/README.md#gs-server-updates) for polling timing, notification deduplication, availability, and signature requirements. Confirm a notice on an eligible test client before claiming the UI was verified.

On an eligible Windows client, check that the prompt names the intended release, approve installation and any Windows administrator prompt, then verify the reopened executable's actual ProductVersion. An all-users installation requires administrator approval. A verified download or installer handoff is not a completed native upgrade; record a cancelled or timed-out permission request as incomplete acceptance. The [NSIS installation rules](../../apps/desktop/README.md#desktop-packaging) describe directory replacement during elevation.

If authentication returns 401, obtain the release token for the selected environment; do not retry local seed passwords. If an upload or publication times out, inspect the public file and `current` before repeating the operation. If the POST succeeded but the reply was lost, a matching readback establishes completion. If readback differs, reconcile the current notice before another write. Restore a previous notice only through an authorized publication operation; changing the notice cannot downgrade an already installed client. Keep old installers available for existing download links.

## Dev Note

Windows 2.2.6 was published on 2026-10-13 with its enterprise-signed companion at the [installer URL](https://8.138.102.170/downloads/gs-worker-2.2.6-win-x64-unsigned.exe) plus `.release.json`. The 307,856,233-byte installer has SHA-256 `7bb54487948c1e7dc6b3cce895960d486c17653afece2cf872385442f2d4473b`. Local/server hashes, anonymous HEAD and Range, real HTTPS download, enterprise verification, pre-handoff integrity, build identity, packaged-runtime checks, and eight native directory-transaction cases passed. The all-users installed-upgrade probe timed out waiting for Windows consent; its stopped process and absent installation registrations were confirmed. Full client upgrade acceptance remains unverified. The same-version notice was then updated with manual recovery instructions and the download address, and its complete readback matched the submitted notes.

The 2.2.2 Windows client predates enterprise release manifests. Its native-signature rule rejects unsigned updates; migrating to a manifest-verifying client requires one manual installation. Subsequent Windows updates use the signed manifest and installer digest.
