/** Endpoint validation, precedence, and override persistence. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  assertGsEndpoint,
  GS_DEFAULT_ENDPOINT,
  GsEndpointStore,
  parseGsEndpointOverride,
} from '../src/endpoint.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gs-endpoint-'))
  dirs.push(dir)
  return dir
}

it('uses the deployed gsclaw prefix when no endpoint override is configured', async () => {
  const store = await GsEndpointStore.load({ stateDir: await stateDir(), environment: '', fallback: GS_DEFAULT_ENDPOINT })
  expect(store.resolve()).toBe('https://192.168.230.108:8151/gsclaw')
})

it('accepts loopback http and encrypted LAN endpoints and normalizes trailing slashes', () => {
  expect(assertGsEndpoint('http://127.0.0.1:8151/gsworker/')).toBe('http://127.0.0.1:8151/gsworker')
  expect(assertGsEndpoint(' https://192.168.1.10:8151 ')).toBe('https://192.168.1.10:8151')
  expect(assertGsEndpoint('http://[::1]:8151')).toBe('http://[::1]:8151')
  expect(assertGsEndpoint('https://gsclaw.example.com/gsworker')).toBe('https://gsclaw.example.com/gsworker')
})

it('rejects non-http schemes, credentials, query, fragment, and plain http on public hosts', () => {
  for (const value of [
    'not-a-url',
    'ftp://127.0.0.1',
    'http://user:pass@127.0.0.1',
    'http://127.0.0.1/?x=1',
    'http://127.0.0.1/#frag',
    'http://gsclaw.example.com',
    'http://10.0.0.2',
    'http://192.168.1.10',
    'http://10.attacker.invalid',
    'http://192.168.attacker.invalid',
    'http://127.attacker.invalid',
  ]) {
    expect(() => assertGsEndpoint(value)).toThrow(/gsclaw-server endpoint/)
    expect(parseGsEndpointOverride(value)).toBeUndefined()
  }
})

it('resolves persisted override over environment over the configured fallback', async () => {
  const dir = await stateDir()
  const store = await GsEndpointStore.load({
    stateDir: dir,
    environment: 'http://127.0.0.1:9000/env',
    fallback: 'http://127.0.0.1:8000/fallback',
  })
  expect(store.resolve()).toBe('http://127.0.0.1:9000/env')
  await store.setOverride('http://127.0.0.1:7000/override/')
  expect(store.resolve()).toBe('http://127.0.0.1:7000/override')
  expect(store.persistedOverride).toBe('http://127.0.0.1:7000/override')

  const reloaded = await GsEndpointStore.load({
    stateDir: dir,
    environment: 'http://127.0.0.1:9000/env',
    fallback: 'http://127.0.0.1:8000/fallback',
  })
  expect(reloaded.resolve()).toBe('http://127.0.0.1:7000/override')
  await reloaded.clearOverride()
  expect(reloaded.resolve()).toBe('http://127.0.0.1:9000/env')
})

it('rejects an invalid environment value and tolerates corrupt state', async () => {
  const dir = await stateDir()
  await expect(GsEndpointStore.load({
    stateDir: dir,
    environment: 'http://public.example.com',
    fallback: 'https://gsclaw.example.com/gsworker',
  })).rejects.toThrow(/requires https/)

  await writeFile(join(dir, 'gs-endpoint.json'), 'not json\n')
  const corrupted = await GsEndpointStore.load({ stateDir: dir, environment: '', fallback: GS_DEFAULT_ENDPOINT })
  expect(corrupted.resolve()).toBe(GS_DEFAULT_ENDPOINT)
  expect(corrupted.persistedOverride).toBeUndefined()
})

it('rejects an unsafe configured fallback at load', async () => {
  const dir = await stateDir()
  await expect(GsEndpointStore.load({ stateDir: dir, fallback: 'http://public.example.com' }))
    .rejects.toThrow(/requires https/)
})
