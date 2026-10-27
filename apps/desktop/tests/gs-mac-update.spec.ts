/** Private local-feed staging never authorizes replacement before the shell's separate consent. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }))
import { GsMacUpdateInstaller } from '../src/gs-mac-update.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gs-mac-update-'))
  const installedBundle = '/Applications/GS.app'
  const bytes = Buffer.from('OS-verified application ZIP fixture')
  const identity = { identifier: 'com.enterprise.officeagent', version: '2.2.11', executable: 'GS' }
  let feed = ''
  let metadata: { version: string; path: string; sha512: string } | undefined
  const updater = {
    updateConfigPath: '', disableDifferentialDownload: false, autoInstallOnAppQuit: true, autoRunAppAfterInstall: false,
    checkForUpdates: vi.fn(async () => {
      const config = JSON.parse(await readFile(updater.updateConfigPath, 'utf8')) as { url: string }
      feed = config.url
      const response = await fetch(new URL('latest-mac.yml', feed))
      metadata = await response.json() as typeof metadata
      return { isUpdateAvailable: true, updateInfo: { version: metadata!.version } }
    }),
    downloadUpdate: vi.fn(async () => {
      const zip = await fetch(new URL(metadata!.path, feed))
      const downloaded = Buffer.from(await zip.arrayBuffer())
      expect(downloaded).toEqual(bytes)
      expect(createHash('sha512').update(downloaded).digest('base64')).toBe(metadata!.sha512)
    }),
    quitAndInstall: vi.fn(),
  }
  const operations = {
    mount: vi.fn(async (_artifact: string, _mount: string) => {}),
    unmount: vi.fn(async (_mount: string) => {}),
    identity: vi.fn(async (bundle: string) => ({ ...identity, version: bundle === installedBundle ? '2.2.10' : identity.version })),
    archive: vi.fn(async (_bundle: string, zip: string, _arch: string, _signal: AbortSignal) => { await writeFile(zip, bytes) }),
  }
  const verifyBundle = vi.fn(async (_bundle: string) => {})
  const installer = new GsMacUpdateInstaller({ directory, installedBundle, arch: 'arm64', verifyBundle }, updater, operations)
  onTestFinished(async () => {
    try { await installer.dispose() } finally { await rm(directory, { recursive: true, force: true }) }
  })
  return { installer, updater, operations, identity, directory, verifyBundle, feed: () => feed }
}

it('stages a verified same-product bundle on a private local feed and waits for explicit installation', async () => {
  const f = await fixture()
  await f.installer.prepare('download.dmg', '2.2.11')
  expect(f.verifyBundle).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('GS.app'))
  expect(f.updater.autoInstallOnAppQuit).toBe(false)
  expect(f.updater.autoRunAppAfterInstall).toBe(true)
  expect(f.updater.disableDifferentialDownload).toBe(true)
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled()
  expect(f.operations.unmount).toHaveBeenCalledOnce()
  expect(await readdir(f.directory)).toEqual([])
  expect(new URL(f.feed()).hostname).toBe('127.0.0.1')
  f.installer.install()
  expect(f.updater.quitAndInstall).toHaveBeenCalledOnce()
})

it.each(['identifier', 'version'] as const)('rejects mismatched application %s before ZIP preparation', async (field) => {
  const f = await fixture()
  f.identity[field] = 'wrong'
  if (field === 'identifier') {
    f.operations.identity.mockImplementation(async bundle => ({ ...f.identity,
      identifier: bundle.startsWith('/Applications/') ? 'com.enterprise.officeagent' : 'wrong' }))
  }
  await expect(f.installer.prepare('download.dmg', '2.2.11')).rejects.toThrow('(prepare)')
  expect(f.operations.archive).not.toHaveBeenCalled()
  expect(() => { f.installer.install() }).toThrow('(not-ready)')
  expect(await readdir(f.directory)).toEqual([])
})

it('refuses an untrusted extracted app and unmounts even after an unsuccessful attach', async () => {
  const f = await fixture()
  f.verifyBundle.mockRejectedValueOnce(new Error('Gatekeeper refused'))
  await expect(f.installer.prepare('download.dmg', '2.2.11')).rejects.toThrow('(prepare)')
  expect(f.operations.archive).not.toHaveBeenCalled()
  f.operations.mount.mockRejectedValueOnce(new Error('attach failed'))
  await expect(f.installer.prepare('download.dmg', '2.2.11')).rejects.toThrow('(prepare)')
  expect(f.operations.unmount).toHaveBeenCalledTimes(2)
  expect(await readdir(f.directory)).toEqual([])
})

it('keeps installation unavailable after native-cache failure', async () => {
  const f = await fixture()
  f.updater.downloadUpdate.mockRejectedValueOnce(new Error('cache full'))
  await expect(f.installer.prepare('download.dmg', '2.2.11')).rejects.toThrow('(prepare)')
  expect(() => { f.installer.install() }).toThrow('(not-ready)')
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled()
  expect(await readdir(f.directory)).toEqual([])
})

it('waits for pending native work to stop before disposing and denies later handoff', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const attached = Promise.withResolvers<undefined>()
  f.operations.mount.mockImplementation(async () => { entered.resolve(undefined); await attached.promise })
  const preparing = f.installer.prepare('download.dmg', '2.2.11')
  const rejected = expect(preparing).rejects.toThrow('(prepare)')
  await entered.promise
  let disposed = false
  const closing = f.installer.dispose().then(() => { disposed = true })
  expect(disposed).toBe(false)
  attached.resolve(undefined)
  await rejected
  await closing
  expect(f.operations.unmount).toHaveBeenCalledOnce()
  expect(f.updater.checkForUpdates).not.toHaveBeenCalled()
  expect(() => { f.installer.install() }).toThrow()
  expect(await readdir(f.directory)).toEqual([])
})

it('retains an unclean mount stage and reports cleanup failure instead of installation readiness', async () => {
  const f = await fixture()
  f.operations.unmount.mockRejectedValueOnce(new Error('volume busy'))
  await expect(f.installer.prepare('download.dmg', '2.2.11')).rejects.toMatchObject({ kind: 'cleanup' })
  expect((await readdir(f.directory))).toHaveLength(1)
  expect(() => { f.installer.install() }).toThrow('(not-ready)')
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled()
})
