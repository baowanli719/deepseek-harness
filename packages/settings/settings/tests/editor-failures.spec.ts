/** File failures between validation and commit must not persist partial edits. */
import * as fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { configurationFixture } from './configuration-fixture.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readFile: vi.fn(original.readFile), rename: vi.fn(original.rename) }
})
afterEach(() => {
  vi.mocked(fs.readFile).mockReset()
  vi.mocked(fs.rename).mockReset()
})

it.each([
  ['denied read', Object.assign(new Error('denied read'), { code: 'EACCES' })],
  ['truncated YAML', '- id: ['],
  ['wrong document', '{}'],
] as const)('refuses %s observed after initial validation', async (_name, result) => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  const before = readFileSync(profile.patchPath, 'utf8')
  const read = vi.mocked(fs.readFile)
  if (typeof result === 'string') read.mockResolvedValueOnce(result)
  else read.mockRejectedValueOnce(result)
  await expect(ctx.configEditor.edit(entry, raw => ({ ...raw, count: 6 }))).rejects.toThrow()
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
})

it('creates a patch removed between validation and reading the document', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'first')!
  vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error('removed'), { code: 'ENOENT' }))
  await ctx.configEditor.edit(entry, raw => ({ ...raw, count: 6 }))
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('count: 6')
})

it('leaves the running composition on the old config when a persist failure rejects a default edit', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const before = readFileSync(profile.patchPath, 'utf8')
  vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('EIO: injected persist failure'), { code: 'EIO' }))

  await expect(ctx.settings.update('first', { count: 6 })).rejects.toThrow('EIO')

  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'first')!.value).toEqual({ count: 2, list: [] })
})

it('commits the validated config to the running composition when a persist-failing edit opts in', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const before = readFileSync(profile.patchPath, 'utf8')
  vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('EIO: injected persist failure'), { code: 'EIO' }))

  await expect(ctx.settings.update('first', { count: 6 }, undefined, { applyOnPersistFailure: true })).rejects.toThrow('EIO')

  // The profile patch keeps the old content — the rejection said so — while
  // the running entry already serves the validated next config.
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(ctx.settings.describe({ redactSecrets: true }).find(row => row.ns === 'first')!.value).toEqual({ count: 6, list: [] })
})
