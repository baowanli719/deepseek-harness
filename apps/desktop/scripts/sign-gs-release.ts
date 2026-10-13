/** Produce an enterprise Windows release manifest without exporting its private signing key. */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { GS_RELEASE_KEYS } from '../src/gs-release-keys.ts'
import { verifyGsReleaseManifest, type GsReleaseManifest } from '../src/gs-release-manifest.ts'

/**
 * Sign exact manifest bytes with an embedded application's Ed25519 release identity.
 * @param manifest - Installer identity, digest, and expiration validated against the application.
 * @param privatePem - Operator-owned PKCS8 private key, never returned or logged.
 * @param keys - Public identities accepted by the target application.
 * @returns A detached envelope suitable for the installer URL's .release.json companion.
 */
export function signGsReleaseManifest(
  manifest: GsReleaseManifest, privatePem: string, keys: Readonly<Record<string, string>> = GS_RELEASE_KEYS,
): { keyId: string; payload: string; signature: string } {
  const privateKey = createPrivateKey(privatePem)
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('GS release requires an Ed25519 private key')
  const publicKey = createPublicKey(privateKey)
  const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const payload = Buffer.from(JSON.stringify(manifest), 'utf8')
  const envelope = { keyId, payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') }
  verifyGsReleaseManifest(envelope, manifest, keys)
  return envelope
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    installer: { type: 'string' }, url: { type: 'string' }, version: { type: 'string' },
    'key-file': { type: 'string' }, 'expires-at': { type: 'string' }, out: { type: 'string' },
  } })
  const { installer, url, version, out } = values
  const keyFile = values['key-file']
  const expiresAt = values['expires-at']
  if (!installer || !url || !version || !keyFile || !expiresAt || !out) {
    throw new Error('Required: --installer --url --version --key-file --expires-at --out')
  }
  const target = new URL(url)
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) throw new Error('Installer URL must be credential-free HTTPS')
  if (process.platform !== 'win32') throw new Error('Windows release signing requires native installer version inspection')
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/key|secret|token|password|^NODE_OPTIONS$|^NODE_PATH$/iu.test(name)))
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; (Get-Item -LiteralPath $env:GS_RELEASE_INSTALLER).VersionInfo.ProductVersion'], {
    windowsHide: true, timeout: 30_000, env: { ...environment, GS_RELEASE_INSTALLER: resolve(installer) },
  })
  if (stdout.trim() !== version) throw new Error('Notice version must equal installer ProductVersion')
  const file = await stat(installer)
  if (!file.isFile()) throw new Error('Installer must be a regular file')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(installer)) hash.update(chunk)
  const manifest: GsReleaseManifest = {
    schema: 1, product: 'com.enterprise.officeagent', runtimeFamily: 'deepseek-harness',
    version, platform: 'win32', arch: 'x64', url, size: file.size, sha256: hash.digest('hex'), expiresAt,
  }
  const envelope = signGsReleaseManifest(manifest, await readFile(keyFile, 'utf8'))
  await writeFile(out, JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  process.stdout.write(JSON.stringify({ version, bytes: file.size, sha256: manifest.sha256, keyId: envelope.keyId, out }) + '\n')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
