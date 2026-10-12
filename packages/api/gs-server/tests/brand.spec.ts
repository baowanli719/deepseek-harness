/** Brand store: precedence, sanitization, persistence, and clearing. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GS_BRAND_DEFAULT, GsBrandStore, resolveGsBrandConfig } from '../src/brand.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function loadStore(): Promise<GsBrandStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gs-brand-'))
  dirs.push(dir)
  return GsBrandStore.load({ stateDir: dir })
}

it('resolves the built-in default before the server or the cache speaks', async () => {
  const store = await loadStore()
  expect(store.current()).toBe(GS_BRAND_DEFAULT)
  expect(store.view()).toEqual({ name: GS_BRAND_DEFAULT.name, headline: GS_BRAND_DEFAULT.headline })
})

it('sanitizes server candidates field-wise and falls back per field', () => {
  expect(resolveGsBrandConfig(null)).toBeUndefined()
  expect(resolveGsBrandConfig({ name: ' 国盛证券 ', headline: '' })).toEqual({
    name: '国盛证券', headline: GS_BRAND_DEFAULT.headline,
  })
  expect(resolveGsBrandConfig({ name: 'x'.repeat(65) })).toEqual({
    name: GS_BRAND_DEFAULT.name, headline: GS_BRAND_DEFAULT.headline,
  })
  expect(resolveGsBrandConfig({ name: 42 as never })).toEqual({
    name: GS_BRAND_DEFAULT.name, headline: GS_BRAND_DEFAULT.headline,
  })
})

it('persists an accepted brand and prefers it on the next load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gs-brand-'))
  dirs.push(dir)
  const store = await GsBrandStore.load({ stateDir: dir })
  const listener = vi.fn()
  store.subscribe(listener)
  await store.applyServerBrand({ name: '国盛证券', headline: '办公 Agent' })
  expect(store.current()).toEqual({ name: '国盛证券', headline: '办公 Agent' })
  expect(listener).toHaveBeenCalledExactlyOnceWith({ name: '国盛证券', headline: '办公 Agent' })

  const reloaded = await GsBrandStore.load({ stateDir: dir })
  expect(reloaded.current()).toEqual({ name: '国盛证券', headline: '办公 Agent' })

  // A null push clears back to the persisted cache, which now equals the push.
  await reloaded.applyServerBrand(null)
  expect(reloaded.current()).toEqual({ name: '国盛证券', headline: '办公 Agent' })
})

it('ignores a clearing push when nothing was pushed', async () => {
  const store = await loadStore()
  const listener = vi.fn()
  store.subscribe(listener)
  await store.applyServerBrand(undefined)
  expect(listener).not.toHaveBeenCalled()
})
