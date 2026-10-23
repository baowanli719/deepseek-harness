/** Server-pushed notice banner at the top of the conversation content area. */
import { useCallback, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the ui-conversation SlotMap merge (the conversation.notice seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { selectVisibleNotice, type NoticeController } from './controller.ts'
import { NS } from './locale.ts'
import css from './NoticeBanner.module.css'

/** Injected controller shared with the refresh timer. */
export interface NoticeInjected { readonly controller: NoticeController }

/** Conversation-top notice banner. */
export type NoticeBannerProps = PropsRuntime<'conversation.notice'> & PropsLocale<typeof NS> & InjectFace<NoticeInjected>

/**
 * Show the server's current notice while it is active and not dismissed.
 * @param props - controller and localized copy.
 * @returns the banner, or null while no notice is visible.
 */
export function NoticeBanner({ controller, t }: NoticeBannerProps) {
  const subscribe = useCallback((listener: () => void) => controller.state.subscribe(listener), [controller])
  const snapshot = useCallback(() => controller.state.getSnapshot(), [controller])
  const state = useSyncExternalStore(subscribe, snapshot)
  const view = selectVisibleNotice(state, Date.now())
  if (view === null) return null
  return <div role="status" aria-label={t('bannerAria')} className={css.banner}>
    <span className={css.text}>{view.text}</span>
    {view.dismissible !== false && <button type="button" className={css.close} aria-label={t('closeAria')}
      onClick={() => { controller.dismiss() }}>{t('close')}</button>}
  </div>
}
