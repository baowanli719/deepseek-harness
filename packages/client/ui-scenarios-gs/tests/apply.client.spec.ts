// @vitest-environment jsdom
/** Real client composition covers slot/resource disposal, polling cadence, and config validation. */
import { afterEach, expect, vi, type Mock } from 'vitest'
import {
  ClientRoster, createClientTest, webApp, type ClientTestFixtures,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { GsScenarioShortcutsSetting } from '../src/client/contract.ts'
import { apply as hostApply } from '../src/index.ts'
import { apply as clientApply } from '../src/client/apply.tsx'
import { SCENARIO_SHORTCUTS_ADDRESS } from '../src/client/resource.ts'
import { NS } from '../src/client/locale.ts'

const packageName = '@deepseek-ai/dsh-client-ui-scenarios-gs'
const it = createClientTest({
  roster: ClientRoster.of([
    ...webApp.rows,
    {
      name: packageName,
      inject: ['@deepseek-ai/dsh-client-ui-conversation'],
      immediately: false,
    },
  ]),
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function response(setting?: GsScenarioShortcutsSetting): Response {
  return new Response(JSON.stringify(setting === undefined ? {} : { scenarioShortcuts: setting }), { status: 200 })
}

type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
function scenarioCalls(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(call => call[0] === 'api/gs-server/scenario-shortcuts')
}

it('occupies the composer seat, opens on plugin startup, and leaves on dispose', async ({ start }) => {
  const fetchMock = vi.fn(() => Promise.resolve(response()))
  vi.stubGlobal('fetch', fetchMock)
  const client = await start()
  const entries = client.ctx.slots.entries('conversation.composer.shortcuts')
  expect(entries).toHaveLength(1)
  expect(entries[0]!.locale).toBe(NS)

  const source = client.ctx.resources.source(SCENARIO_SHORTCUTS_ADDRESS)
  await vi.waitFor(() => { expect(scenarioCalls(fetchMock)).toHaveLength(1) })
  await vi.waitFor(() => { expect(source.getSnapshot()).toMatchObject({ status: 'live', value: undefined }) })
  await client.unload(packageName)
  await client.flush()
  expect(client.ctx.slots.entries('conversation.composer.shortcuts')).toEqual([])
  expect(source.getSnapshot().status).toBe('none')
}, 60_000)

it('keeps the pinned stream and value after the last component holder releases', async ({ start }) => {
  const setting: GsScenarioShortcutsSetting = {
    enabled: true,
    items: [{ id: 'custom', label: '自定义场景', skill: 'custom-skill' }],
  }
  const fetchMock = vi.fn(() => Promise.resolve(response(setting)))
  vi.stubGlobal('fetch', fetchMock)
  const client = await start()
  const source = client.ctx.resources.source(SCENARIO_SHORTCUTS_ADDRESS)
  await vi.waitFor(() => { expect(scenarioCalls(fetchMock)).toHaveLength(1) })
  await vi.waitFor(() => { expect(source.getSnapshot()).toMatchObject({ status: 'live', value: setting }) })
  const signal = scenarioCalls(fetchMock)[0]?.[1]?.signal

  const release = source.subscribe(() => {})
  release()
  expect(signal?.aborted).toBe(false)
  expect(scenarioCalls(fetchMock)).toHaveLength(1)
  expect(source.getSnapshot()).toMatchObject({ status: 'live', value: setting })
  await client.unload(packageName)
  await client.flush()
  expect(signal?.aborted).toBe(true)
  expect(source.getSnapshot().status).toBe('none')
}, 60_000)

it('aborts on plugin unload and drops a late fetch result', async ({ start }) => {
  const pending = Promise.withResolvers<Response>()
  const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pending.promise)
  vi.stubGlobal('fetch', fetchMock)
  const client = await start()
  const source = client.ctx.resources.source(SCENARIO_SHORTCUTS_ADDRESS)
  await vi.waitFor(() => { expect(scenarioCalls(fetchMock)).toHaveLength(1) })
  const signal = scenarioCalls(fetchMock)[0]?.[1]?.signal

  await client.unload(packageName)
  await client.flush()
  expect(signal?.aborted).toBe(true)
  pending.resolve(response({ enabled: true, items: [{ id: 'late', label: 'late', skill: 'late' }] }))
  await client.flush()
  expect(source.getSnapshot()).toMatchObject({ status: 'none', value: undefined })
}, 60_000)

it('rejects invalid refresh intervals before applying the plugin', async ({ start }) => {
  const client = await start()
  const message = 'ui-scenarios-gs: config.refreshIntervalSeconds must be a positive finite number of seconds'
  expect(() => { clientApply(client.ctx, { refreshIntervalSeconds: 0 }) }).toThrow(message)
  expect(() => { clientApply(client.ctx, { refreshIntervalSeconds: -5 }) }).toThrow(message)
  expect(() => { clientApply(client.ctx, { refreshIntervalSeconds: Number.NaN }) }).toThrow(message)
  expect(() => { clientApply(client.ctx, { refreshIntervalSeconds: Number.POSITIVE_INFINITY }) }).toThrow(message)
  expect(() => { clientApply(client.ctx, { refreshIntervalSeconds: '60' as never }) }).toThrow(message)
}, 60_000)

async function expectPolling(
  start: ClientTestFixtures['start'], config: Parameters<typeof clientApply>[1], delay: number,
): Promise<void> {
  const client = await start()
  await client.unload(packageName)
  await client.flush()
  const fetchMock = vi.fn(() => Promise.resolve(response()))
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers()
  clientApply(client.ctx, config)
  await vi.waitFor(() => { expect(scenarioCalls(fetchMock)).toHaveLength(1) })
  await vi.advanceTimersByTimeAsync(delay)
  expect(scenarioCalls(fetchMock)).toHaveLength(2)
}

it('polls every 300 seconds by default', async ({ start }) => {
  await expectPolling(start, undefined, 300_000)
}, 60_000)

it('accepts a positive custom refresh interval', async ({ start }) => {
  await expectPolling(start, { refreshIntervalSeconds: 60 }, 60_000)
}, 60_000)

it('host apply registers nothing', () => {
  hostApply()
})
