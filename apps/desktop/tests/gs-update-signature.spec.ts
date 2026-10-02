/** Installer identity checks fail before any native execution. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})
import { verifyGsUpdateSignature } from '../src/gs-update-signature.ts'

it('requires valid installed and downloaded signatures, timestamp, and the same certificate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gs-signature-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'download.exe')
  await writeFile(path, 'fixture')
  const identity = 'A'.repeat(40)
  const valid = { installedValid: true, downloadValid: true, timestamped: true, installedSigner: identity, downloadSigner: identity }
  execute.mockResolvedValue({ stdout: JSON.stringify(valid), stderr: '' })
  await expect(verifyGsUpdateSignature(path, 'win32', 'installed.exe')).resolves.toBeUndefined()
  for (const change of [{ installedValid: false }, { downloadValid: false }, { timestamped: false }, { downloadSigner: 'B'.repeat(40) }]) {
    execute.mockResolvedValue({ stdout: JSON.stringify({ ...valid, ...change }), stderr: '' })
    await expect(verifyGsUpdateSignature(path, 'win32', 'installed.exe')).rejects.toThrow('identity')
  }
  expect(execute.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, timeout: 60_000 })
  execute.mockReset()
})

it('requires matching macOS Team IDs and successful Gatekeeper assessment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gs-mac-signature-'))
  onTestFinished(() => { execute.mockReset(); return rm(root, { recursive: true, force: true }) })
  const path = join(root, 'download.dmg')
  await writeFile(path, 'fixture')
  execute.mockImplementation(async (command: string, args: string[]) => {
    if (command.endsWith('codesign') && args[0] === '--display') return { stdout: '', stderr: 'TeamIdentifier=GS123\n' }
    return { stdout: '', stderr: '' }
  })
  await verifyGsUpdateSignature(path, 'darwin', '/Applications/GS.app/Contents/MacOS/GS')
  expect(execute.mock.calls.at(-1)?.[0]).toBe('/usr/sbin/spctl')
  execute.mockImplementation(async (command: string, args: string[]) => {
    if (command.endsWith('codesign') && args[0] === '--display') return { stdout: '', stderr: `TeamIdentifier=${args.at(-1) === path ? 'OTHER' : 'GS123'}\n` }
    return { stdout: '', stderr: '' }
  })
  await expect(verifyGsUpdateSignature(path, 'darwin', '/Applications/GS.app/Contents/MacOS/GS')).rejects.toThrow('Team ID')
})
