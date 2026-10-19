/** Provider-driven source links and their shared right Sidebar reader. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LinkPreviewRegistry } from './registry.ts'
import { Reader, ReaderTitle, QuoteNotice, type QuoteNoticeInjected, type ReaderInjected } from './Reader.tsx'
import { NS, en, zh } from './locales.ts'
export type { LinkPreviewDocument, LinkPreviewProvider, LinkPreviewResult, LinkPreviews } from './contract.ts'

const ID = '@deepseek-ai/dsh-client-ui-link-preview'
export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

/** @param ctx - browser root owning reversible provider and Sidebar registrations. */
export function apply(ctx: Context): void {
  const registry = new LinkPreviewRegistry()
  const quoteNotice = createSnapshotStore<ReturnType<QuoteNoticeInjected['hooks']['quoteNotice']['getSnapshot']>>(null)
  let quoteSeq = 0
  const dispose = ctx.reflect.provide('linkPreviews', registry)
  ctx.effect(() => () => { void dispose() }, 'link-preview: registration service')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'link-preview: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID, kind: 'link-preview', multiple: true, title: () => t('title'),
  }), 'link-preview: tab type')
  ctx.on('chat/open-link', (sessionId, url) => {
    const provider = registry.resolve(url)
    if (provider === undefined) return
    ctx.sidebarRight.openTabIn(sessionId, 'link-preview', { params: { provider: provider.name, url } })
    return true
  })
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID, locale: NS,
    inject: (): ReaderInjected => ({
      hooks: { providers: registry.source }, read: (name, url, signal) => registry.read(name, url, signal),
      reportQuote: (inserted) => { quoteNotice.set({ seq: ++quoteSeq, inserted }) },
    }),
  }, Reader))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: ID,
  }, ReaderTitle))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: `${ID}.quote-notice`, locale: NS,
    inject: (): QuoteNoticeInjected => ({ hooks: { quoteNotice }, dismissQuote: () => { quoteNotice.set(null) } }),
  }, QuoteNotice))
}
