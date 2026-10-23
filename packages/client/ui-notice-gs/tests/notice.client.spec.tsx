// @vitest-environment jsdom
/**
 * Banner visibility and dismissal: hidden without an active notice, visible
 * inside the window, and gone after close. Props are fed directly; assertions
 * stay on user-visible behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NoticeController } from '../src/client/controller.ts'
import { NoticeBanner } from '../src/client/NoticeBanner.tsx'
import { zh } from '../src/client/locale.ts'
import type { GsNoticeView } from '../src/client/contract.ts'

const VIEW: GsNoticeView = { text: '系统维护通知：本周六凌晨升级' }

function controllerWith(view: GsNoticeView | null): NoticeController {
  return new NoticeController({ fetchNotice: () => Promise.resolve(view) })
}

function mount(controller: NoticeController) {
  // Session-maybe standard kit the banner never reads: unused Hooks throw.
  return render(<NoticeBanner
    controller={controller}
    t={makeTranslate(zh)}
    sessionId={undefined}
    useSession={(() => { throw new Error('unused') }) as never}
    useProjection={(() => undefined) as never}
    {...allowAllAccess}
    useConversation={(() => { throw new Error('unused') }) as never}
    useInput={(() => { throw new Error('unused') }) as never}
    inputActions={undefined}
    useSessions={(() => { throw new Error('unused') }) as never}
    useSessionStatus={(() => { throw new Error('unused') }) as never}
    useSessionRetainInfo={() => undefined}
    usePanelInfo={(() => { throw new Error('unused') }) as never}
    useWorkspaces={(() => { throw new Error('unused') }) as never}
    useResource={(() => { throw new Error('unused') }) as never}
  />)
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup() })

describe('notice banner', () => {
  it('stays hidden until a notice arrives, then shows it', async () => {
    const controller = controllerWith(VIEW)
    mount(controller)
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => { await controller.refresh() })
    const banner = screen.getByRole('status', { name: zh.bannerAria })
    expect(banner.textContent).toContain(VIEW.text)
  })

  it('hides again when the server removes the notice', async () => {
    let current: GsNoticeView | null = VIEW
    const controller = new NoticeController({ fetchNotice: () => Promise.resolve(current) })
    await act(async () => { await controller.refresh() })
    mount(controller)
    expect(screen.queryByRole('status')).not.toBeNull()
    current = null
    await act(async () => { await controller.refresh() })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('disappears after close and stays dismissed on a later session', async () => {
    const controller = controllerWith(VIEW)
    await act(async () => { await controller.refresh() })
    mount(controller)
    fireEvent.click(screen.getByRole('button', { name: zh.closeAria }))
    expect(screen.queryByRole('status')).toBeNull()
    cleanup()
    const reloaded = controllerWith(VIEW)
    await act(async () => { await reloaded.refresh() })
    mount(reloaded)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('offers no close control for a non-dismissible notice', async () => {
    const controller = controllerWith({ ...VIEW, dismissible: false })
    await act(async () => { await controller.refresh() })
    mount(controller)
    expect(screen.getByRole('status', { name: zh.bannerAria }).textContent).toContain(VIEW.text)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('stays hidden outside the display window', async () => {
    const expired = { ...VIEW, endAt: '2000-01-01T00:00:00.000Z' }
    const controller = controllerWith(expired)
    await act(async () => { await controller.refresh() })
    mount(controller)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
