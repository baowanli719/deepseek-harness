// @vitest-environment jsdom
/** Loader composition mounts the conversation notice seat and disposes it; the refresh-interval config fails loud. */
import { expect, vi } from 'vitest'
import { ClientRoster, createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { apply as hostApply } from '../src/index.ts'
import { apply as clientApply } from '../src/client/apply.tsx'
import type { NoticeInjected } from '../src/client/NoticeBanner.tsx'
import { NS } from '../src/client/locale.ts'

const packageName = '@deepseek-ai/dsh-client-ui-notice-gs'
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

it('occupies the conversation notice seat and leaves on dispose', async ({ start }) => {
  const client = await start()
  const entries = client.ctx.slots.entries('conversation.notice')
  expect(entries).toHaveLength(1)
  expect(entries[0]!.locale).toBe(NS)
  const face = entries[0]!.inject?.() as NoticeInjected | undefined
  expect(face).toBeDefined()
  expect(face!.controller).toBeDefined()
  await client.unload(packageName)
  await client.flush()
  expect(client.ctx.slots.entries('conversation.notice')).toEqual([])
}, 60_000)

it('rejects an invalid refresh interval before touching the context', async ({ start }) => {
  const client = await start()
  const message = 'ui-notice-gs: config.refreshIntervalSeconds must be a positive finite number of seconds'
  expect(() => { clientApply(client.ctx, { refreshIntervalSeconds: 0 }) }).toThrow(message)
  expect(() => { clientApply(client.ctx, { refreshIntervalSeconds: -5 }) }).toThrow(message)
  expect(() => { clientApply(client.ctx, { refreshIntervalSeconds: Number.NaN }) }).toThrow(message)
  expect(() => { clientApply(client.ctx, { refreshIntervalSeconds: Number.POSITIVE_INFINITY }) }).toThrow(message)
  expect(() => { clientApply(client.ctx, { refreshIntervalSeconds: '60' as never }) }).toThrow(message)
}, 60_000)

it('accepts a positive finite refresh interval', async ({ start }) => {
  const client = await start()
  await client.unload(packageName)
  await client.flush()
  vi.useFakeTimers()
  try {
    clientApply(client.ctx, { refreshIntervalSeconds: 60 })
    expect(client.ctx.slots.entries('conversation.notice')).toHaveLength(1)
    // The interval callback re-polls on the configured cadence.
    await vi.advanceTimersByTimeAsync(60_000)
  } finally {
    vi.useRealTimers()
  }
}, 60_000)

it('host apply registers nothing', () => {
  hostApply()
})
