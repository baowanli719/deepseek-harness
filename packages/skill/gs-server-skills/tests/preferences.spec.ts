import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GsSkillExecutionClient } from '../src/execution.ts'
import { ServerSkillPreferences } from '../src/preferences.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('server skill preferences', () => {
  it('reads the previous gs-worker account hash and updates only that account', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gs-skill-preferences-'))
    roots.push(root)
    const key = 'https://gs.example.test#7'
    const account = createHash('sha256').update(key).digest('hex')
    const directory = join(root, account)
    await mkdir(directory)
    await writeFile(join(directory, 'research.json'), 'false')
    const client = {
      meta: vi.fn(async () => ({ skillExecution: { version: 1, types: ['data-query'] } })),
      catalog: vi.fn(async () => ({ skills: [{ name: 'research', displayName: 'Research', description: 'Research',
        version: '1', runtimeType: 'data-query', definitionRevision: 'r1', defaultEnabled: true }] })),
    } satisfies Pick<GsSkillExecutionClient, 'meta' | 'catalog'>
    const invalidate = vi.fn()
    let currentKey: string | undefined = key
    const preferences = new ServerSkillPreferences({
      root, accountKey: () => currentKey, client, config: () => undefined, invalidate,
    })
    expect(await preferences.list()).toEqual([{ name: 'research', description: 'Research', runtimeType: 'data-query', enabled: false, available: true }])
    await preferences.setEnabled('research', true)
    expect(await readFile(join(directory, 'research.json'), 'utf8')).toBe('true')
    expect(invalidate).toHaveBeenCalledTimes(1)
    currentKey = 'https://gs.example.test#8'
    expect(await preferences.enabledFor({ name: 'research', defaultEnabled: true })).toBe(true)
    currentKey = undefined
    await expect(preferences.setEnabled('research', false)).rejects.toThrow('skill unavailable')
  })

  it('reports runtime and policy causes without enabling blocked skills', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gs-skill-reasons-'))
    roots.push(root)
    const client = {
      meta: vi.fn(async () => ({ skillExecution: { version: 1, policyVersion: 1, types: ['data-query', 'server-mcp'] } })),
      catalog: vi.fn(async () => ({ skills: [
        { name: 'client-skill', runtimeType: 'client', modelPolicy: 'standard' },
        { name: 'private-skill', runtimeType: 'data-query', modelPolicy: 'trusted-only' },
        { name: 'private-client-skill', runtimeType: 'client', modelPolicy: 'trusted-only' },
        { name: 'unknown-skill', runtimeType: 'future', modelPolicy: 'standard' },
        { name: 'silent-skill', runtimeType: 'server-mcp', modelPolicy: 'standard', defaultEnabled: false },
      ] })),
    } as never
    const preferences = new ServerSkillPreferences({
      root, accountKey: () => 'https://gs.example.test#7', client, config: () => undefined, invalidate: vi.fn(),
    })
    const rows = await preferences.list()
    expect(rows).toMatchObject([
      { name: 'client-skill', enabled: true, available: true },
      { name: 'private-skill', enabled: true, available: false, policy: 'trusted-only', unavailableReason: 'trusted-session-required' },
      { name: 'private-client-skill', enabled: true, available: false, policy: 'trusted-only', unavailableReason: 'trusted-session-required' },
      { name: 'unknown-skill', enabled: true, available: false, unavailableReason: 'runtime-unsupported' },
      { name: 'silent-skill', enabled: false, available: true },
    ])
    // Client-runtime skills load through the bundle cache: no blocker remains.
    expect(rows[0]).not.toHaveProperty('unavailableReason')
    for (const name of ['private-skill', 'private-client-skill', 'unknown-skill']) {
      await expect(preferences.setEnabled(name, true)).rejects.toThrow('skill unavailable')
    }
    await preferences.setEnabled('client-skill', false)
    expect((await preferences.list()).find(row => row.name === 'client-skill'))
      .toMatchObject({ enabled: false, available: true })
    await preferences.setEnabled('silent-skill', true)
    expect((await preferences.list()).find(row => row.name === 'silent-skill')).toMatchObject({ enabled: true, available: true })
  })
})
