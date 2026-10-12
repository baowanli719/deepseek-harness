// @vitest-environment jsdom
/** Product account takeover in the shipped desktop client roster. */
import { afterEach, expect, vi } from 'vitest'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import * as account from '../src/client/index.ts'

const it = createClientTest({ roster: webApp })
afterEach(() => { vi.unstubAllGlobals() })

it('shadows the desktop account launcher and restores it after removal', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const client = await start()
  const standard = client.ctx.slots.entries('settings.launcher')[0]!
  expect(standard.options.priority ?? 0).toBe(0)
  const product = client.ctx.plugin(account)
  await client.flush()
  const entries = client.ctx.slots.entries('settings.launcher')
  expect(entries).toHaveLength(2)
  expect(entries[0]!.options.priority).toBe(-10)
  expect(entries[1]!.component).toBe(standard.component)
  await product.dispose()
  await client.flush()
  expect(client.ctx.slots.entries('settings.launcher')).toEqual([standard])
}, 60_000)
