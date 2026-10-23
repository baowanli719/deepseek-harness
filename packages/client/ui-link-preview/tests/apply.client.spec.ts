// @vitest-environment jsdom
/** Plugin-owned navigation and reversible registrations over the real tab registry. */
import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { SidebarRightTabRegistry } from '../../ui-sidebar-right/src/client/tab-registry.ts'
import { apply, inject } from '../src/client/index.ts'
import { apply as hostSeat } from '../src/index.ts'
import type { ReaderInjected, QuoteNoticeInjected } from '../src/client/Reader.tsx'

it('opens the originating Session and removes interception when the plugin unloads', async () => {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  const openTabIn = vi.fn()
  hostSeat()
  ctx.provide('sidebarRight', { openTabIn } as never)
  ctx.provide('sidebarRightTabs', tabs as never)
  const registrations: { name: string; inject?: () => ReaderInjected | QuoteNoticeInjected }[] = []
  ctx.provide('slots', {
    inject: (_name: string, register: () => unknown) => register(),
    register: (options: typeof registrations[number]) => { registrations.push(options); return () => {} },
  } as never)
  ctx.provide('locale', { bind: () => (key: string) => key, register: () => () => {} } as never)
  try {
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const disposeProvider = ctx.linkPreviews.register({
      name: 'test', accepts: url => url.hostname === 'source.test',
      read: async () => ({ status: 'ok', document: { title: null, content: 'source', truncated: false } }),
    })
    const sessionId = SessionId('source-session')
    expect(ctx.bail('chat/open-link', sessionId, 'https://source.test/original')).toBe(true)
    expect(openTabIn).toHaveBeenCalledWith(sessionId, 'link-preview', {
      params: { provider: 'test', url: 'https://source.test/original' },
    })
    expect(ctx.bail('chat/open-link', sessionId, 'https://other.test/')).toBeUndefined()
    disposeProvider()
    expect(ctx.bail('chat/open-link', sessionId, 'https://source.test/original')).toBeUndefined()
    expect(tabs.get('link-preview')).toBeDefined()
    expect(tabs.get('link-preview')?.title('')).toBe('title')
    const face = registrations.find(entry => entry.name === 'sidebar.right.pane.tab')?.inject?.()
    const notice = registrations.find(entry => entry.name === 'shell.overlay')?.inject?.()
    if (face === undefined || !('read' in face) || notice === undefined || !('dismissQuote' in notice)) throw new Error('missing reader registrations')
    expect(await face.read('test', 'https://source.test/original', new AbortController().signal)).toEqual({ status: 'unavailable' })
    const changed = vi.fn()
    const unsubscribe = notice.hooks.quoteNotice.subscribe(changed)
    face.reportQuote(true)
    expect(notice.hooks.quoteNotice.getSnapshot()).toEqual({ seq: 1, inserted: true })
    face.reportQuote(false)
    expect(notice.hooks.quoteNotice.getSnapshot()).toEqual({ seq: 2, inserted: false })
    notice.dismissQuote()
    expect(notice.hooks.quoteNotice.getSnapshot()).toBeNull()
    expect(changed).toHaveBeenCalledTimes(3)
    unsubscribe()
    await fiber.dispose()
    expect(tabs.get('link-preview')).toBeUndefined()
    expect(ctx.get('linkPreviews')).toBeUndefined()
    expect(ctx.bail('chat/open-link', sessionId, 'https://source.test/original')).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})
