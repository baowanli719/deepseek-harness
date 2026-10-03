import { expect, it, vi } from 'vitest'
import { GsUpdateNotifications } from '../src/gs-update-notifications.ts'

it('notifies once per version across concurrent checks and allows a later version', async () => {
  const pending = Promise.withResolvers<undefined>()
  const prompt = vi.fn(() => pending.promise)
  const notifications = new GsUpdateNotifications(prompt)
  const first = notifications.available('2.2.0')
  await notifications.available('2.2.0')
  expect(prompt).toHaveBeenCalledTimes(1)
  const next = notifications.available('2.2.1')
  const latest = notifications.available('2.2.2')
  await Promise.resolve()
  expect(prompt).toHaveBeenCalledTimes(1)
  pending.resolve(undefined)
  await first
  await next
  await latest
  expect(prompt).toHaveBeenCalledTimes(2)
})

it('does not repeatedly open a failing native prompt during background checks', async () => {
  const prompt = vi.fn(async () => { throw new Error('closed during shutdown') })
  const notifications = new GsUpdateNotifications(prompt)
  await expect(notifications.available('2.2.0')).rejects.toThrow('closed during shutdown')
  await notifications.available('2.2.0')
  expect(prompt).toHaveBeenCalledTimes(1)
})
