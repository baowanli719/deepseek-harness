/** Verify downloaded GS installers against OS trust and the installed signing identity. */
import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** Publisher attributes shared by a certificate and its renewals. */
const PUBLISHER_ATTRIBUTES = ['CN', 'O', 'C'] as const

/**
 * Parse an X.500 subject string into uppercase attribute names and values.
 * @param name - Distinguished name using backslash escapes, as Windows formats certificate subjects.
 * @returns Attributes by name, or undefined for a malformed name.
 */
export function parseCertificateSubject(name: string): Map<string, string> | undefined {
  const attributes = new Map<string, string>()
  let key = ''
  let value = ''
  let escaped = false
  let readingKey = true
  const commit = (): boolean => {
    const normalized = key.trim().toUpperCase()
    if (normalized === '') return false
    attributes.set(normalized, value.trim())
    key = ''
    value = ''
    readingKey = true
    return true
  }
  for (const character of name) {
    if (escaped) {
      escaped = false
      if (readingKey) key += character
      else value += character
      continue
    }
    if (character === '\\') { escaped = true; continue }
    if (readingKey && character === '=') { readingKey = false; continue }
    if (!readingKey && character === ',') {
      if (!commit()) return undefined
      continue
    }
    if (readingKey) key += character
    else value += character
  }
  return escaped || readingKey || !commit() ? undefined : attributes
}

/**
 * Compare the publisher identity of two certificate subjects.
 * @param installedSubject - Subject of the installed application's signer.
 * @param downloadSubject - Subject of the downloaded installer's signer.
 * @returns Whether both subjects name the same nonempty CN, O, and C.
 */
export function samePublisherSubject(installedSubject: string, downloadSubject: string): boolean {
  const installed = parseCertificateSubject(installedSubject)
  const download = parseCertificateSubject(downloadSubject)
  if (installed === undefined || download === undefined) return false
  return PUBLISHER_ATTRIBUTES.every((attribute) => {
    const value = installed.get(attribute)
    return value !== undefined && value !== '' && value === download.get(attribute)
  })
}

/**
 * Refuse unsigned, modified, or differently signed installers before native execution.
 * Windows requires a valid timestamped download whose signer names the installed publisher's
 * CN, O, and C, so certificate renewal under the same identity still updates; macOS requires the
 * installed Team ID and a Gatekeeper-approved signed disk image.
 * @param artifact - completely downloaded installer.
 * @param platform - native operating system.
 * @param installedExecutable - trusted installed application executable.
 */
export async function verifyGsUpdateSignature(
  artifact: string, platform: NodeJS.Platform = process.platform, installedExecutable = process.execPath,
): Promise<void> {
  const stat = await lstat(artifact)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('GS update requires a regular installer file')
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/key|secret|token|password|^NODE_OPTIONS$|^NODE_PATH$/iu.test(name)))
  const options = { env: environment, encoding: 'utf8' as const, windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 }
  if (platform === 'win32') {
    const script = '$ErrorActionPreference="Stop"; Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"; Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1"; $installed=Get-AuthenticodeSignature -LiteralPath $env:GS_VERIFY_INSTALLED; $download=Get-AuthenticodeSignature -LiteralPath $env:GS_VERIFY_ARTIFACT; [pscustomobject]@{installedValid=($installed.Status -eq "Valid");downloadValid=($download.Status -eq "Valid");installedSigner=$installed.SignerCertificate.Subject;downloadSigner=$download.SignerCertificate.Subject;timestamped=($null -ne $download.TimeStamperCertificate)}|ConvertTo-Json -Compress'
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      ...options, env: { ...environment, GS_VERIFY_INSTALLED: installedExecutable, GS_VERIFY_ARTIFACT: artifact },
    })
    const value: unknown = JSON.parse(stdout)
    if (typeof value !== 'object' || value === null) throw new Error('GS update signature inspection failed')
    const signature = value as Record<string, unknown>
    if (signature.installedValid !== true || signature.downloadValid !== true || signature.timestamped !== true
      || typeof signature.installedSigner !== 'string' || typeof signature.downloadSigner !== 'string'
      || !samePublisherSubject(signature.installedSigner, signature.downloadSigner)) {
      throw new Error('GS update signing identity does not match the installed application')
    }
    return
  }
  if (platform === 'darwin') {
    const installed = resolve(dirname(installedExecutable), '..', '..')
    for (const path of [installed, artifact]) await execute('/usr/bin/codesign', ['--verify', '--strict', path], options)
    const identities = await Promise.all([installed, artifact].map(async (path) => {
      const { stderr } = await execute('/usr/bin/codesign', ['--display', '--verbose=4', path], options)
      return /^TeamIdentifier=([A-Z0-9]+)$/mu.exec(stderr)?.[1]
    }))
    if (identities[0] === undefined || identities[0] !== identities[1]) throw new Error('GS update Team ID does not match the installed application')
    await execute('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', artifact], options)
    return
  }
  throw new Error('GS native updates are unavailable on this platform')
}
