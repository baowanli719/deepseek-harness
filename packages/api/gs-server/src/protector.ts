/**
 * Refresh-token protection seam.
 *
 * The gsclaw-server refresh token is a rotating, single-use credential and
 * the only one persisted across restarts, so it must be sealed by OS-backed
 * secret storage before it touches the disk. Electron's `safeStorage` filled
 * this role in the desktop product; this module defines the headless
 * replacement. The Windows implementation shells out to PowerShell's
 * `System.Security.Cryptography.ProtectedData` (DPAPI, `CurrentUser` scope).
 * Platforms without an implementation get a protector that reports itself
 * unavailable, and the auth state machine refuses login rather than writing
 * the token in plaintext — the misconfiguration fails loud.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * OS-backed secret storage seam for the refresh token. Implementations are
 * async so subprocess-backed protectors (DPAPI via PowerShell) fit the same
 * contract as in-process ones.
 */
export interface GsRefreshTokenProtector {
  /** Whether sealing is backed by the OS rather than plaintext. */
  available(): boolean
  /**
   * Seal one UTF-8 secret.
   * @param plaintext - the refresh token to seal.
   * @returns the sealed bytes safe to persist.
   */
  protect(plaintext: string): Promise<Uint8Array>
  /**
   * Open one sealed secret.
   * @param sealed - bytes previously returned by {@link GsRefreshTokenProtector.protect}.
   * @returns the original plaintext.
   */
  unprotect(sealed: Uint8Array): Promise<string>
}

/** Inputs for the Windows DPAPI protector. */
export interface GsDpapiProtectorOptions {
  /** PowerShell executable; defaults to `powershell.exe` resolved through PATH. */
  readonly executable?: string
  /** Per-invocation deadline in milliseconds. */
  readonly timeoutMs?: number
}

const DPAPI_TIMEOUT_MS = 10_000

const DPAPI_PROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$sealed = [System.Security.Cryptography.ProtectedData]::Protect(',
  '  $data, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($sealed))',
].join('\n')

const DPAPI_UNPROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$sealed = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$data = [System.Security.Cryptography.ProtectedData]::Unprotect(',
  '  $sealed, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($data))',
].join('\n')

/** Failure raised when the DPAPI subprocess cannot seal or open a secret. */
export class GsDpapiError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GsDpapiError'
  }
}

function runDpapi(
  executable: string,
  script: string,
  input: Buffer,
  timeoutMs: number,
): Promise<Buffer> {
  return runSecretProcess(executable, ['-NoProfile', '-NonInteractive', '-Command', script], input, timeoutMs)
}

function runSecretProcess(executable: string, args: readonly string[], input: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    let outputBytes = 0
    let oversized = false
    const timer = setTimeout(() => {
      child.kill()
      timedOut = true
    }, timeoutMs)
    let timedOut = false
    const fail = (cause: unknown): void => {
      clearTimeout(timer)
      rejectPromise(cause instanceof GsDpapiError ? cause : new GsDpapiError('DPAPI invocation failed', { cause }))
    }
    child.on('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > 2 * 1024 * 1024) { oversized = true; child.kill(); return }
      stdout.push(chunk)
    })
    child.stderr.resume()
    child.stdin.on('error', () => { child.kill() })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) { rejectPromise(new GsDpapiError('OS token protector invocation timed out')); return }
      if (oversized) { rejectPromise(new GsDpapiError('OS token protector output exceeded its limit')); return }
      if (code !== 0) {
        rejectPromise(new GsDpapiError(`OS token protector exited with code ${String(code)}`))
        return
      }
      resolvePromise(Buffer.concat(stdout))
    })
    child.stdin.end(input)
  })
}

/**
 * Encrypt refresh tokens with AES-GCM using a key held only in the login Keychain.
 * Key creation sends random hex through stdin; no secret appears in argv or files.
 * @returns an OS-backed macOS protector; locked or unavailable Keychains fail closed.
 */
export function macOsKeychainProtector(): GsRefreshTokenProtector {
  let keyInFlight: Promise<Buffer> | undefined
  const key = (): Promise<Buffer> => keyInFlight ??= (async () => {
    const args = ['find-generic-password', '-a', 'gs-worker', '-s', 'gs-worker.refresh-token-key', '-w']
    let value: Buffer
    try {
      value = await runSecretProcess('/usr/bin/security', args, Buffer.alloc(0), DPAPI_TIMEOUT_MS)
    } catch {
      // Creation never updates an existing item; a concurrent creator wins safely.
      const hex = randomBytes(32).toString('hex')
      await runSecretProcess('/usr/bin/security', ['-i'],
        Buffer.from(`add-generic-password -a gs-worker -s gs-worker.refresh-token-key -w ${hex}\n`), DPAPI_TIMEOUT_MS)
        .catch(() => { /* A competing creator is resolved by the authoritative read below. */ })
      value = await runSecretProcess('/usr/bin/security', args, Buffer.alloc(0), DPAPI_TIMEOUT_MS)
    }
    const hex = value.toString('utf8').trim()
    if (!/^[a-f\d]{64}$/u.test(hex)) throw new GsDpapiError('Invalid refresh-token Keychain key')
    return Buffer.from(hex, 'hex')
  })().catch((cause: unknown) => { keyInFlight = undefined; throw cause })
  return {
    available: () => true,
    async protect(plaintext) {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', await key(), nonce)
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted])
    },
    async unprotect(sealed) {
      const bytes = Buffer.from(sealed)
      if (bytes.length < 29 || bytes[0] !== 1) throw new GsDpapiError('Invalid sealed macOS refresh token')
      const cipher = createDecipheriv('aes-256-gcm', await key(), bytes.subarray(1, 13))
      cipher.setAuthTag(bytes.subarray(13, 29))
      return Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]).toString('utf8')
    },
  }
}

/**
 * Windows DPAPI protector: each seal/open runs one PowerShell invocation of
 * `ProtectedData.Protect`/`Unprotect` under `CurrentUser` scope, so only the
 * same OS user on the same machine can open the persisted refresh token.
 * Secrets cross the process boundary as base64 on stdin/stdout and never
 * appear on the command line.
 * @param options - executable and deadline overrides.
 * @returns the protector; {@link GsRefreshTokenProtector.available} is always true.
 */
export function windowsDpapiProtector(options: GsDpapiProtectorOptions = {}): GsRefreshTokenProtector {
  const executable = options.executable ?? 'powershell.exe'
  const timeoutMs = options.timeoutMs ?? DPAPI_TIMEOUT_MS
  return {
    available: () => true,
    async protect(plaintext: string): Promise<Uint8Array> {
      const input = Buffer.from(plaintext, 'utf8').toString('base64')
      const output = await runDpapi(executable, DPAPI_PROTECT_SCRIPT, Buffer.from(input, 'utf8'), timeoutMs)
      const sealed = Buffer.from(output.toString('utf8').trim(), 'base64')
      if (sealed.byteLength === 0) throw new GsDpapiError('DPAPI returned an empty sealed blob')
      return sealed
    },
    async unprotect(sealed: Uint8Array): Promise<string> {
      const input = Buffer.from(sealed).toString('base64')
      const output = await runDpapi(executable, DPAPI_UNPROTECT_SCRIPT, Buffer.from(input, 'utf8'), timeoutMs)
      const plaintext = Buffer.from(output.toString('utf8').trim(), 'base64').toString('utf8')
      if (plaintext === '') throw new GsDpapiError('DPAPI returned an empty secret')
      return plaintext
    },
  }
}

/**
 * Protector for platforms without an OS-backed implementation. Every
 * operation throws and {@link GsRefreshTokenProtector.available} is false, so
 * the auth state machine refuses login instead of persisting the refresh
 * token in plaintext.
 * @param platform - platform value reported in failure messages.
 * @returns the fail-closed protector.
 */
export function unavailableRefreshTokenProtector(platform: string): GsRefreshTokenProtector {
  const message = `gsclaw-server refresh-token protection is not implemented on platform "${platform}"; `
    + 'refusing to persist the refresh token in plaintext'
  return {
    available: () => false,
    protect: () => Promise.reject(new GsDpapiError(message)),
    unprotect: () => Promise.reject(new GsDpapiError(message)),
  }
}

/**
 * Resolve the platform default protector: Windows gets DPAPI, macOS gets
 * login Keychain-backed AES-GCM, and other platforms fail closed. Hosts may inject a
 * custom protector through Config.
 * @param platform - Node platform value; defaults to the running process.
 * @returns the protector for the platform.
 */
export function resolvePlatformProtector(platform: NodeJS.Platform = process.platform): GsRefreshTokenProtector {
  if (platform === 'win32') return windowsDpapiProtector()
  if (platform === 'darwin') return macOsKeychainProtector()
  return unavailableRefreshTokenProtector(platform)
}
