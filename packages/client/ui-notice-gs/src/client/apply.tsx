/** Server notice banner: polls the gs-server loopback route and occupies conversation.notice. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createNoticeApi } from './api.ts'
import { NoticeController } from './controller.ts'
import { en, NS, zh } from './locale.ts'
import { NoticeBanner } from './NoticeBanner.tsx'

/** Required services for dictionary registration and the notice slot. */
export const inject = ['slots', 'locale']

/** Plugin configuration from cordis.yml. */
export interface Config {
  /** Seconds between notice polls; defaults to 300. */
  readonly refreshIntervalSeconds?: number
}

/** Poll cadence when cordis.yml does not set one. */
const DEFAULT_REFRESH_INTERVAL_SECONDS = 300

function resolveRefreshIntervalSeconds(config: Config | undefined): number {
  const value = config?.refreshIntervalSeconds
  if (value === undefined) return DEFAULT_REFRESH_INTERVAL_SECONDS
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('ui-notice-gs: config.refreshIntervalSeconds must be a positive finite number of seconds')
  }
  return value
}

/**
 * Register the notice dictionary, poll the loopback route, and mount the banner.
 * @param ctx - client root context.
 * @param config - plugin configuration; an invalid interval fails the load.
 */
export function apply(ctx: ClientContext, config?: Config): void {
  const intervalMs = resolveRefreshIntervalSeconds(config) * 1000
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-notice-gs: dictionaries')
  const controller = new NoticeController(createNoticeApi())
  ctx.effect(() => {
    void controller.refresh()
    const timer = setInterval(() => { void controller.refresh() }, intervalMs)
    return () => { clearInterval(timer) }
  }, 'ui-notice-gs: refresh')
  ctx.slots.inject('conversation.notice', () => ctx.slots.register({
    name: 'conversation.notice',
    id: 'gs-notice',
    locale: NS,
    inject: () => ({ controller }),
  }, NoticeBanner))
}
