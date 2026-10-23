/** Provider frames, sequential polling, and abort compliance. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { ResourceRegistry } from '@deepseek-ai/dsh-client-resources/src/client/resources.ts'
import type { GsScenarioShortcutsSetting } from '../src/client/contract.ts'
import { createScenarioShortcutsResource, SCENARIO_SHORTCUTS_ADDRESS } from '../src/client/resource.ts'

const CUSTOM: GsScenarioShortcutsSetting = {
  enabled: true,
  items: [{ id: 'custom', label: '自定义场景', skill: 'custom-skill' }],
}

const contexts: Context[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function open(
  fetchScenarioShortcuts: (signal: AbortSignal) => Promise<GsScenarioShortcutsSetting>,
  signal: AbortSignal,
  intervalMs = 60_000,
) {
  return createScenarioShortcutsResource({ fetchScenarioShortcuts }, intervalMs)
    .open(SCENARIO_SHORTCUTS_ADDRESS, { signal })[Symbol.asyncIterator]()
}

it('starts with defaults and emits fetched custom and null settings on successive polls', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const fetchScenarioShortcuts = vi.fn()
    .mockResolvedValueOnce(CUSTOM)
    .mockResolvedValueOnce(null)
  const iterator = open(fetchScenarioShortcuts, controller.signal)

  await expect(iterator.next()).resolves.toEqual({ done: false, value: { ok: true, value: undefined } })
  await expect(iterator.next()).resolves.toEqual({ done: false, value: { ok: true, value: CUSTOM } })
  expect(fetchScenarioShortcuts.mock.calls[0]?.[0]).toBe(controller.signal)
  const polling = iterator.next()
  await vi.advanceTimersByTimeAsync(60_000)
  await expect(polling).resolves.toEqual({ done: false, value: { ok: true, value: null } })
  await iterator.return?.()
})

it('emits failure frames while the resource registry retains the last successful value', async () => {
  vi.useFakeTimers()
  const ctx = new Context()
  contexts.push(ctx)
  const registry = new ResourceRegistry(ctx)
  const fetchScenarioShortcuts = vi.fn()
    .mockResolvedValueOnce(CUSTOM)
    .mockRejectedValueOnce(new Error('offline'))
  ctx.effect(() => registry.register(createScenarioShortcutsResource({ fetchScenarioShortcuts }, 60_000)))
  const source = registry.source(SCENARIO_SHORTCUTS_ADDRESS)
  const release = source.subscribe(() => {})

  await vi.waitFor(() => { expect(source.getSnapshot()).toMatchObject({ status: 'live', value: CUSTOM }) })
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() => { expect(source.getSnapshot().status).toBe('failed') })
  expect(source.getSnapshot()).toMatchObject({
    status: 'failed', value: CUSTOM, failure: { code: 'gateway/internal', message: 'offline' },
  })
  release()
})

it('aborts an in-flight request and does not emit a late value', async () => {
  const controller = new AbortController()
  const pending = Promise.withResolvers<GsScenarioShortcutsSetting>()
  const fetchScenarioShortcuts = vi.fn((_signal: AbortSignal) => pending.promise)
  const iterator = open(fetchScenarioShortcuts, controller.signal)
  await iterator.next()
  const fetching = iterator.next()

  controller.abort()
  expect(fetchScenarioShortcuts.mock.calls[0]?.[0].aborted).toBe(true)
  pending.resolve(CUSTOM)
  await expect(fetching).resolves.toEqual({ done: true, value: undefined })
})

it('aborts and cleans up the delay between polls', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const fetchScenarioShortcuts = vi.fn().mockResolvedValue(CUSTOM)
  const iterator = open(fetchScenarioShortcuts, controller.signal)
  await iterator.next()
  await iterator.next()
  const waiting = iterator.next()
  expect(vi.getTimerCount()).toBe(1)

  controller.abort()
  await expect(waiting).resolves.toEqual({ done: true, value: undefined })
  expect(vi.getTimerCount()).toBe(0)
  expect(fetchScenarioShortcuts).toHaveBeenCalledTimes(1)
})
