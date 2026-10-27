import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GsDesktopReleaseSource, parseGsDesktopRelease } from '../src/gs-updates.ts'
import { zh } from '../src/locale.ts'

const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const notice = { version: '2.2.0', downloads: { windowsX64: 'https://lan.example/gs-worker.exe' }, notes: ['更新说明'] }

async function release(body = new Uint8Array(128), appUpdate: unknown = notice,
  prepare?: (path: string, version: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'gs-update-'))
  directories.push(directory)
  const pull = vi.fn(async () => ({ appUpdate }))
  const request = vi.fn(async (_url: string, _init: RequestInit) => new Response(body, { headers: { 'content-length': String(body.byteLength) } }))
  const install = vi.fn(async (_path: string) => {})
  const verify = vi.fn(async (_path: string) => {})
  const source = new GsDesktopReleaseSource({ directory, pull, request, install, verify, platform: 'win32', arch: 'x64', messages: () => zh,
    ...(prepare === undefined ? {} : { prepare }) })
  return { source, directory, pull, request, install, verify }
}

describe('GS desktop server release channel', () => {
  it('does not fabricate a download percentage when content length is unknown', async () => {
    const bytes = Buffer.alloc(128)
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.set([0x50, 0x45, 0, 0], 64)
    const f = await release(bytes)
    f.request.mockImplementationOnce(async () => new Response(bytes))
    const progress = vi.fn()
    await f.source.check()
    await f.source.download('2.2.0', progress)
    expect(progress.mock.calls).toEqual([[100]])
    f.source.dispose()
  })
  it('enters verification before OS validation finishes and invalidates failed platform preparation', async () => {
    const bytes = Buffer.alloc(128)
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.set([0x50, 0x45, 0, 0], 64)
    const prepare = vi.fn(async () => { throw new Error('platform stage failed') })
    const f = await release(bytes, notice, prepare)
    const entered = Promise.withResolvers<undefined>()
    const verified = Promise.withResolvers<undefined>()
    f.verify.mockImplementationOnce(async () => { entered.resolve(undefined); await verified.promise })
    await f.source.check()
    const progress = vi.fn()
    const pending = f.source.download('2.2.0', progress)
    await entered.promise
    expect(progress).toHaveBeenLastCalledWith(100)
    expect(f.install).not.toHaveBeenCalled()
    verified.resolve(undefined)
    await pending
    await expect(f.source.prepare('2.2.0')).rejects.toThrow('platform stage failed')
    await expect(f.source.install('2.2.0')).rejects.toThrow(zh.gsUpdateStale)
    expect(f.install).not.toHaveBeenCalled()
    f.source.dispose()
  })
  it('enforces daily download windows before requesting installer bytes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 2, 9, 0))
    const { source, request } = await release(undefined, { ...notice, downloadWindow: { start: '22:00', end: '06:00' } })
    await source.check()
    await expect(source.download('2.2.0', () => {})).rejects.toThrow(zh.gsUpdateNotAvailable)
    expect(request).not.toHaveBeenCalled()
    source.dispose()
  })

  it('rechecks authenticity at install time and refuses a changed download', async () => {
    const bytes = Buffer.alloc(128)
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.set([0x50, 0x45, 0, 0], 64)
    const { source, verify, install } = await release(bytes)
    await source.check()
    await source.download('2.2.0', () => {})
    verify.mockRejectedValue(new Error('changed installer'))
    await expect(source.install('2.2.0')).rejects.toThrow('changed installer')
    expect(verify).toHaveBeenCalledTimes(2)
    expect(install).not.toHaveBeenCalled()
    source.dispose()
  })
  it('accepts HTTPS download links and rejects HTTP, credentials, commands, malformed versions, and invalid windows', () => {
    expect(parseGsDesktopRelease(notice)).toEqual(notice)
    expect(parseGsDesktopRelease(null)).toBeNull()
    for (const version of ['v2.2.0', '2.2.0-rc.1', '../installer']) expect(parseGsDesktopRelease({ ...notice, version })).toBeUndefined()
    for (const url of ['http://lan.example/a.exe', 'file:///C:/installer.exe', 'https://user:secret@example.com/a.exe', 'javascript:alert(1)']) {
      expect(parseGsDesktopRelease({ ...notice, downloads: { windowsX64: url } })).toBeUndefined()
    }
    expect(parseGsDesktopRelease({ ...notice, downloadWindow: { start: '25:00', end: '18:00' } })).toBeUndefined()
  })

  it('withholds a PE-shaped installer when OS signature verification fails', async () => {
    const bytes = Buffer.alloc(128)
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.set([0x50, 0x45, 0, 0], 64)
    const { source, verify, install, directory } = await release(bytes)
    verify.mockRejectedValue(new Error('unsigned installer'))
    await source.check()
    await expect(source.download('2.2.0', () => {})).rejects.toThrow('unsigned installer')
    await expect(source.install('2.2.0')).rejects.toThrow(zh.gsUpdateStale)
    expect(await readdir(directory)).toEqual([])
    expect(install).not.toHaveBeenCalled()
    source.dispose()
  })

  it('actively checks the server and never downloads during a check', async () => {
    const { source, pull, request, install } = await release()
    expect(await source.check()).toBe('2.2.0')
    expect(await source.check()).toBe('2.2.0')
    expect(pull).toHaveBeenCalledTimes(2)
    expect(request).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    source.dispose()
  })

  it('separates a missing release from malformed configuration and signed-out checks', async () => {
    const empty = await release(undefined, null)
    expect(await empty.source.check()).toBeUndefined()
    const malformed = await release(undefined, {})
    await expect(malformed.source.check()).rejects.toThrow(zh.gsUpdateInvalid)
    empty.source.dispose(); malformed.source.dispose()
  })

  it('validates a complete PE installer and hands off only the confirmed version', async () => {
    const bytes = Buffer.alloc(128)
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.set([0x50, 0x45, 0, 0], 64)
    const { source, request, install } = await release(bytes)
    await source.check()
    await expect(source.download('9.9.9', () => {})).rejects.toThrow(zh.gsUpdateStale)
    await source.download('2.2.0', () => {})
    expect(request.mock.calls[0]?.[0]).toBe(notice.downloads.windowsX64)
    expect(install).not.toHaveBeenCalled()
    await expect(source.install('9.9.9')).rejects.toThrow(zh.gsUpdateStale)
    await source.install('2.2.0')
    expect(await readFile(install.mock.calls[0]![0])).toEqual(bytes)
    source.dispose()
    await expect(source.install('2.2.0')).rejects.toThrow()
  })

  it('rejects HTML downloads and removes incomplete artifacts', async () => {
    const { source, directory, install } = await release(new TextEncoder().encode('<html>not an installer</html>'))
    await source.check()
    await expect(source.download('2.2.0', () => {})).rejects.toThrow(zh.gsUpdateDownloadFailed)
    expect(await readdir(directory)).toEqual([])
    expect(install).not.toHaveBeenCalled()
    source.dispose()
  })

  it('respects future availability before making any download request', async () => {
    const { source, request } = await release(undefined, { ...notice, availableFrom: '2099-01-01T00:00:00Z' })
    await source.check()
    await expect(source.download('2.2.0', () => {})).rejects.toThrow(zh.gsUpdateNotAvailable)
    expect(request).not.toHaveBeenCalled()
    source.dispose()
  })
})
