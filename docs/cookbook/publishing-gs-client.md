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

GS installation through the client requires the [native signature checks](../../apps/desktop/README.md#gs-server-updates). An unsigned test installer can be hosted and announced for manual installation; label it as unsigned in the notes. Do not present it as a signed automatic update. Deploy required backend interfaces before advertising features that depend on them; image understanding uses the server-managed vision model and its dedicated interface.

Use PowerShell, `curl.exe`, and the configured `litellm-aliyun` SSH host for the file-server checksum. Set `GS_RELEASE_INSTALLER` to the local installer path, `GS_UPLOAD_NETRC` to the operator's upload credential file, and `RELEASE_API_TOKEN` from the selected deployment's secret configuration. The upload account is `gs-upload`; the operator credential file is conventionally `%USERPROFILE%\.config\gs-worker\upload.netrc`. Keep tokens, passwords, and credential files out of Git, installers, command-line arguments, and operation logs. A local seed account is not the deployment's release credential.

The commands below share one PowerShell session. The `2.2.0` value is an example; choose the actual version of the next release.

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

The file server stores public installers under `/opt/gs-downloads/`. The alternative gsclaw-server upload is `PUT /api/admin/releases/packages/windowsX64/<filename>` with raw binary content and release authentication; it returns the artifact's size, SHA-256 and download path. Its reverse proxy must accept the installer size. Use the verified HTTPS file-server link for this deployment instead of changing proxy limits during a release.

<a id="publish-notice"></a>

## 4. Publish the update notice

Publish only after hosting verification. `POST /api/admin/releases/publish` replaces the global `appUpdate` notice, including its platform download map. Include only platforms with installers for the declared version: retaining an older macOS or UOS binary under the new version would advertise the wrong upgrade. Other server configuration remains unchanged.

Write the JSON to a UTF-8 file and send its bytes so Chinese notes reach the server unchanged. Set `availableFrom` only when downloads must wait until an ISO 8601 time. A future availability time permits a notice before downloading. When configured, `downloadWindow` limits downloads inside the desktop client, including manually confirmed downloads; it does not restrict the anonymous file-server URL. The minimal immediate Windows publication is:

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

Keep the upload response, local and server checksums, HTTP verification, previous notice, submitted JSON, and publish response together. Upload success is not release success; publication becomes effective through the authenticated client configuration.

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

If authentication returns 401, obtain the release token for the selected environment; do not retry local seed passwords. If an upload or publication times out, inspect the public file and `current` before repeating the operation. If the POST succeeded but the reply was lost, a matching readback establishes completion. If readback differs, reconcile the current notice before another write. Restore a previous notice only through an authorized publication operation; changing the notice cannot downgrade an already installed client. Keep old installers available for existing download links.

## Dev Note

The Windows 2.2.0 test installer was uploaded and its notice was read back on 2026-10-11. Its 304,914,491 bytes had matching local/server SHA-256, anonymous HEAD returned 200, and Range returned 206 with matching prefix bytes. Packaged-runtime, native Sharp, vision-plugin loading, build identity, and hidden composer-control checks passed. Publication verification did not launch a signed-in client or verify the live vision backend. These observations describe that test artifact; they do not qualify a signed production release.

The 2.2.2 Windows package was built unsigned on 2026-10-12 because the signing certificate was unavailable on the packaging host: `gs-worker-2.2.2-win-x64-unsigned.exe`, 307,843,114 bytes. Its runtime, Office conversion, and skill CLI checks passed. It must be distributed for manual installation with an unsigned label in the notes; clients cannot install it through the update flow, and clients that install it cannot install later updates until a signed build replaces them.
