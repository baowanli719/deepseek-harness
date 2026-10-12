/** Installer identity checks fail before any native execution. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})
import { parseCertificateSubject, samePublisherSubject, verifyGsUpdateSignature } from '../src/gs-update-signature.ts'

const SUBJECT = 'CN=Example Technology Co.\\, Ltd., O=Example Technology Co.\\, Ltd., C=CN'

it('requires valid installed and downloaded signatures, timestamp, and the same publisher subject', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gs-signature-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'download.exe')
  await writeFile(path, 'fixture')
  const valid = { installedValid: true, downloadValid: true, timestamped: true, installedSigner: SUBJECT, downloadSigner: SUBJECT }
  execute.mockResolvedValue({ stdout: JSON.stringify(valid), stderr: '' })
  await expect(verifyGsUpdateSignature(path, 'win32', 'installed.exe')).resolves.toBeUndefined()
  for (const change of [
    { installedValid: false },
    { downloadValid: false },
    { timestamped: false },
    { downloadSigner: 'CN=Other Technology Co.\\, Ltd., O=Other Technology Co.\\, Ltd., C=CN' },
    { downloadSigner: 'not a distinguished name' },
  ]) {
    execute.mockResolvedValue({ stdout: JSON.stringify({ ...valid, ...change }), stderr: '' })
    await expect(verifyGsUpdateSignature(path, 'win32', 'installed.exe')).rejects.toThrow('identity')
  }
  expect(execute.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, timeout: 60_000 })
  execute.mockReset()
})

it('accepts a renewed certificate that keeps the installed publisher subject', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gs-signature-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'download.exe')
  await writeFile(path, 'fixture')
  // Renewal can reorder or extend the subject; only the CN, O, and C identity must persist.
  const renewed = 'O=Example Technology Co.\\, Ltd., C=CN, CN=Example Technology Co.\\, Ltd., serialNumber=91000000MA1X00000X'
  execute.mockResolvedValue({ stdout: JSON.stringify({
    installedValid: true, downloadValid: true, timestamped: true, installedSigner: SUBJECT, downloadSigner: renewed,
  }), stderr: '' })
  await expect(verifyGsUpdateSignature(path, 'win32', 'installed.exe')).resolves.toBeUndefined()
  execute.mockReset()
})

describe('parseCertificateSubject', () => {
  it('parses attributes case-insensitively and preserves escaped characters', () => {
    expect(parseCertificateSubject('cn=Example, o=Example\\, Inc., C=CN'))
      .toEqual(new Map([['CN', 'Example'], ['O', 'Example, Inc.'], ['C', 'CN']]))
    expect(parseCertificateSubject('no equals sign')).toBeUndefined()
    expect(parseCertificateSubject('=value')).toBeUndefined()
    expect(parseCertificateSubject('CN=trailing\\')).toBeUndefined()
  })
})

describe('samePublisherSubject', () => {
  it('matches the CN, O, and C identity only', () => {
    expect(samePublisherSubject(SUBJECT, SUBJECT)).toBe(true)
    expect(samePublisherSubject(SUBJECT, 'C=CN, O=Example Technology Co.\\, Ltd., CN=Example Technology Co.\\, Ltd.')).toBe(true)
    expect(samePublisherSubject(SUBJECT, 'CN=Example Technology Co.\\, Ltd., C=CN')).toBe(false)
    expect(samePublisherSubject(SUBJECT, 'CN=, O=Example Technology Co.\\, Ltd., C=CN')).toBe(false)
    expect(samePublisherSubject(SUBJECT, 'CN=example technology co.\\, ltd., O=Example Technology Co.\\, Ltd., C=CN')).toBe(false)
    expect(samePublisherSubject(SUBJECT, 'garbage')).toBe(false)
  })
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
