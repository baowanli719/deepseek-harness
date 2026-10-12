/** Authenticate enterprise installers with release keys independently of Windows Authenticode. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { GS_RELEASE_KEYS } from './gs-release-keys.ts'

/** Signed bytes describing one enterprise Windows installer. */
export interface GsReleaseManifest {
  readonly schema: 1
  readonly product: 'com.enterprise.officeagent'
  readonly runtimeFamily: 'deepseek-harness'
  readonly version: string
  readonly platform: 'win32'
  readonly arch: 'x64'
  readonly url: string
  readonly size: number
  readonly sha256: string
  readonly expiresAt: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function base64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw new Error('Invalid release manifest encoding')
  return bytes
}

/**
 * Verify exact signed payload bytes and bind them to the confirmed release and native target.
 * @param envelope - Untrusted detached manifest response.
 * @param expected - Confirmed version, download URL, and installer target.
 * @param keys - Public keys embedded in the application, never supplied by the server.
 * @returns An authenticated, unexpired installer description.
 */
export function verifyGsReleaseManifest(
  envelope: unknown,
  expected: { version: string; url: string; platform: string; arch: string },
  keys: Readonly<Record<string, string>> = GS_RELEASE_KEYS,
): GsReleaseManifest {
  if (!record(envelope) || typeof envelope.keyId !== 'string' || typeof envelope.payload !== 'string'
    || envelope.payload.length > 12_000 || typeof envelope.signature !== 'string') {
    throw new Error('Invalid release manifest envelope')
  }
  const pem = Object.hasOwn(keys, envelope.keyId) ? keys[envelope.keyId] : undefined
  if (pem === undefined) throw new Error('Unknown release signing key')
  const payload = base64(envelope.payload)
  const signature = base64(envelope.signature)
  const publicKey = createPublicKey(pem)
  if (publicKey.asymmetricKeyType !== 'ed25519' || signature.length !== 64
    || !verify(null, payload, publicKey, signature)) throw new Error('Release manifest signature is invalid')
  const value: unknown = JSON.parse(payload.toString('utf8'))
  if (!record(value) || value.schema !== 1 || value.product !== 'com.enterprise.officeagent'
    || value.runtimeFamily !== 'deepseek-harness' || value.platform !== 'win32' || value.arch !== 'x64'
    || value.platform !== expected.platform || value.arch !== expected.arch
    || value.version !== expected.version || value.url !== expected.url
    || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.version)
    || typeof value.url !== 'string' || typeof value.size !== 'number'
    || !Number.isSafeInteger(value.size) || value.size < 64 || value.size > 2 * 1024 ** 3
    || typeof value.sha256 !== 'string' || !/^[a-f\d]{64}$/u.test(value.sha256)
    || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= Date.now()) throw new Error('Release manifest does not authorize this installer')
  return {
    schema: 1, product: value.product, runtimeFamily: value.runtimeFamily,
    version: value.version, platform: value.platform, arch: value.arch, url: value.url,
    size: value.size, sha256: value.sha256, expiresAt: value.expiresAt,
  }
}

/**
 * Recheck installer bytes and manifest expiry after download and immediately before execution.
 * @param path - Private, completely written installer path.
 * @param manifest - Previously authenticated release description.
 */
export async function verifyGsReleaseArtifact(path: string, manifest: GsReleaseManifest): Promise<void> {
  if (Date.parse(manifest.expiresAt) <= Date.now()) throw new Error('Release manifest has expired')
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Release installer must be a regular file')
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size !== manifest.size) throw new Error('Installer size differs from the signed release')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    if (hash.digest('hex') !== manifest.sha256) throw new Error('Installer hash differs from the signed release')
  } finally {
    await file.close()
  }
}
