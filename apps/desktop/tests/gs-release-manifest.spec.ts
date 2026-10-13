/** Enterprise release signatures authorize exact installer bytes, never server-selected keys. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { GsDesktopReleaseSource } from '../src/gs-updates.ts'
import { verifyGsReleaseManifest, type GsReleaseManifest } from '../src/gs-release-manifest.ts'
import { signGsReleaseManifest } from '../scripts/sign-gs-release.ts'
import { zh } from '../src/locale.ts'

const keys = generateKeyPairSync('ed25519')
const keyId = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
const publicKeys = { [keyId]: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() }
const installer = Buffer.alloc(128)
installer.write('MZ'); installer.writeUInt32LE(64, 60); installer.set([0x50, 0x45, 0, 0], 64)
const manifest: GsReleaseManifest = {
  schema: 1, product: 'com.enterprise.officeagent', runtimeFamily: 'deepseek-harness',
  version: '2.2.4', platform: 'win32', arch: 'x64', url: 'https://lan.example/gs-worker-2.2.4.exe',
  size: installer.length, sha256: createHash('sha256').update(installer).digest('hex'), expiresAt: '2099-01-01T00:00:00Z',
}

function envelope(value: unknown = manifest) {
  const payload = Buffer.from(JSON.stringify(value))
  return { keyId, payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') }
}

async function release(metadata: unknown = envelope(), body: Uint8Array = installer) {
  const directory = await mkdtemp(join(tmpdir(), 'gs-release-manifest-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const install = vi.fn(async (_path: string) => {})
  const verify = vi.fn(async (_path: string) => { throw new Error('Authenticode is unavailable') })
  const request = vi.fn(async (url: string) => url.endsWith('.release.json')
    ? new Response(JSON.stringify(metadata)) : new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } }))
  const source = new GsDesktopReleaseSource({
    directory, pull: async () => ({ appUpdate: { version: manifest.version, downloads: { windowsX64: manifest.url } } }),
    request, install, verify, manifestKeys: publicKeys, platform: 'win32', arch: 'x64', messages: () => zh,
  })
  onTestFinished(() => { source.dispose() })
  return { directory, source, request, install, verify }
}

describe('enterprise release manifests', () => {
  it('installs an unsigned PE after authenticating the release and rechecking its bytes', async () => {
    const { source, install, verify, request } = await release()
    expect(await source.check()).toBe('2.2.4')
    await source.download('2.2.4', () => {})
    await source.install('2.2.4')
    expect(request.mock.calls.map(call => call[0])).toEqual([manifest.url + '.release.json', manifest.url])
    expect(verify).not.toHaveBeenCalled()
    expect(install).toHaveBeenCalledOnce()
  })

  it('rejects missing, altered, unknown-key, oversized, and wrong-version manifests before downloading an installer', async () => {
    const altered = envelope()
    altered.payload = Buffer.from(JSON.stringify({ ...manifest, sha256: '0'.repeat(64) })).toString('base64')
    for (const value of [null, altered, { ...envelope(), keyId: '__proto__' },
      { ...envelope(), padding: 'x'.repeat(17_000) }, envelope({ ...manifest, version: '2.2.3' })]) {
      const { source, request, install } = await release(value)
      await source.check()
      await expect(source.download('2.2.4', () => {})).rejects.toThrow(zh.gsUpdateManifestInvalid)
      expect(request).toHaveBeenCalledOnce()
      expect(install).not.toHaveBeenCalled()
    }
  })

  it('rejects a same-size substituted installer and removes downloaded artifacts', async () => {
    const changed = Buffer.from(installer)
    changed[127] = 1
    const { source, directory, install } = await release(envelope(), changed)
    await source.check()
    await expect(source.download('2.2.4', () => {})).rejects.toThrow(zh.gsUpdateIntegrityFailed)
    expect(await readdir(directory)).toEqual([])
    expect(install).not.toHaveBeenCalled()
  })

  it('rechecks changed installer bytes before handing off to native execution', async () => {
    const { source, directory, install } = await release()
    await source.check()
    await source.download('2.2.4', () => {})
    const [name] = await readdir(directory)
    const changed = Buffer.from(installer)
    changed[127] = 1
    await writeFile(join(directory, name!), changed)
    await expect(source.install('2.2.4')).rejects.toThrow(zh.gsUpdateIntegrityFailed)
    expect(install).not.toHaveBeenCalled()
  })

  it('binds authorization to product, runtime family, target, URL, size, digest, and expiry', () => {
    expect(verifyGsReleaseManifest(envelope(), manifest, publicKeys)).toEqual(manifest)
    for (const change of [
      { product: 'other' }, { runtimeFamily: 'other' }, { arch: 'arm64' }, { platform: 'darwin' },
      { url: 'https://other.example/payload.exe' }, { size: 0 }, { size: 2 ** 32 }, { sha256: 'invalid' },
      { expiresAt: '2020-01-01T00:00:00Z' }, { expiresAt: 'invalid' },
    ]) expect(() => verifyGsReleaseManifest(envelope({ ...manifest, ...change }), manifest, publicKeys)).toThrow()
  })

  it('refuses installation when release authorization expires after download', async () => {
    const { source, install } = await release()
    await source.check()
    await source.download('2.2.4', () => {})
    vi.useFakeTimers({ toFake: ['Date'] })
    onTestFinished(() => { vi.useRealTimers() })
    vi.setSystemTime(new Date('2100-01-01T00:00:00Z'))
    await expect(source.install('2.2.4')).rejects.toThrow(zh.gsUpdateIntegrityFailed)
    expect(install).not.toHaveBeenCalled()
  })

  it('signs with an accepted release key and refuses an unrelated publisher key', () => {
    const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(verifyGsReleaseManifest(signGsReleaseManifest(manifest, privatePem, publicKeys), manifest, publicKeys)).toEqual(manifest)
    expect(() => signGsReleaseManifest(manifest, privatePem, {})).toThrow('Unknown release signing key')
  })
})
