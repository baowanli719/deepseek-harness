// @vitest-environment jsdom
/**
 * Notice polling, dismissal persistence, display-window evaluation, and the
 * visibility selector. jsdom supplies localStorage; each test starts cleared.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isNoticeActive, NoticeController, noticeKey, readDismissedKey, selectVisibleNotice, writeDismissedKey,
} from '../src/client/controller.ts'
import type { GsNoticeView } from '../src/client/contract.ts'
import type { NoticeApi } from '../src/client/api.ts'

const VIEW: GsNoticeView = { text: '系统维护通知', startAt: '2026-01-01T00:00:00.000Z' }

function apiReturning(view: GsNoticeView | null): NoticeApi {
  return { fetchNotice: () => Promise.resolve(view) }
}

beforeEach(() => { localStorage.clear() })

describe('noticeKey', () => {
  it('joins text and startAt, treating an absent start as empty', () => {
    expect(noticeKey(VIEW)).toBe('系统维护通知\n2026-01-01T00:00:00.000Z')
    expect(noticeKey({ text: '系统维护通知' })).toBe('系统维护通知\n')
  })
})

describe('isNoticeActive', () => {
  const now = Date.parse('2026-06-15T12:00:00.000Z')
  it('shows a notice without a window', () => {
    expect(isNoticeActive({ text: 'x' }, now)).toBe(true)
  })
  it('honors a start-only window', () => {
    expect(isNoticeActive({ text: 'x', startAt: '2026-06-15T11:00:00.000Z' }, now)).toBe(true)
    expect(isNoticeActive({ text: 'x', startAt: '2026-06-15T13:00:00.000Z' }, now)).toBe(false)
  })
  it('honors an end-only window', () => {
    expect(isNoticeActive({ text: 'x', endAt: '2026-06-15T13:00:00.000Z' }, now)).toBe(true)
    expect(isNoticeActive({ text: 'x', endAt: '2026-06-15T11:00:00.000Z' }, now)).toBe(false)
  })
  it('honors a closed window', () => {
    const view = { text: 'x', startAt: '2026-06-15T11:00:00.000Z', endAt: '2026-06-15T13:00:00.000Z' }
    expect(isNoticeActive(view, now)).toBe(true)
    expect(isNoticeActive(view, Date.parse('2026-06-15T14:00:00.000Z'))).toBe(false)
  })
  it('treats unparseable schedule fields as no limit', () => {
    expect(isNoticeActive({ text: 'x', startAt: 'not-a-date' }, now)).toBe(true)
    expect(isNoticeActive({ text: 'x', endAt: 'not-a-date' }, now)).toBe(true)
  })
})

describe('dismissal persistence', () => {
  it('round-trips the dismissed key through localStorage', () => {
    expect(readDismissedKey()).toBeNull()
    writeDismissedKey('k-1')
    expect(readDismissedKey()).toBe('k-1')
  })
  it('degrades to session-only dismissal when storage is denied', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(readDismissedKey()).toBeNull()
    getItem.mockRestore()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => { writeDismissedKey('k-1') }).not.toThrow()
    setItem.mockRestore()
    expect(readDismissedKey()).toBeNull()
  })
})

describe('selectVisibleNotice', () => {
  const now = Date.parse('2026-06-15T12:00:00.000Z')
  it('returns the view only while present, undismissed, and active', () => {
    expect(selectVisibleNotice({ view: null, dismissedKey: null }, now)).toBeNull()
    expect(selectVisibleNotice({ view: VIEW, dismissedKey: noticeKey(VIEW) }, now)).toBeNull()
    const future = { text: 'x', startAt: '2027-01-01T00:00:00.000Z' }
    expect(selectVisibleNotice({ view: future, dismissedKey: null }, now)).toBeNull()
    expect(selectVisibleNotice({ view: VIEW, dismissedKey: null }, now)).toBe(VIEW)
  })
})

describe('NoticeController', () => {
  it('stores a fetched notice and keeps the persisted dismissal', async () => {
    writeDismissedKey('earlier')
    const controller = new NoticeController(apiReturning(VIEW))
    expect(controller.state.getSnapshot()).toEqual({ view: null, dismissedKey: 'earlier' })
    await controller.refresh()
    expect(controller.state.getSnapshot()).toEqual({ view: VIEW, dismissedKey: 'earlier' })
  })
  it('clears the banner when the server disables the notice', async () => {
    let current: GsNoticeView | null = VIEW
    const controller = new NoticeController({ fetchNotice: () => Promise.resolve(current) })
    await controller.refresh()
    current = null
    await controller.refresh()
    expect(controller.state.getSnapshot().view).toBeNull()
  })
  it('keeps the previous banner when a poll fails', async () => {
    let offline = false
    const controller = new NoticeController({
      fetchNotice: () => offline ? Promise.reject(new Error('offline')) : Promise.resolve(VIEW),
    })
    await controller.refresh()
    offline = true
    await controller.refresh()
    expect(controller.state.getSnapshot().view).toBe(VIEW)
  })
  it('dismisses the current notice until its fingerprint changes', async () => {
    const controller = new NoticeController(apiReturning(VIEW))
    await controller.refresh()
    controller.dismiss()
    const key = noticeKey(VIEW)
    expect(readDismissedKey()).toBe(key)
    expect(controller.state.getSnapshot().dismissedKey).toBe(key)
    const now = Date.parse('2026-06-15T12:00:00.000Z')
    expect(selectVisibleNotice(controller.state.getSnapshot(), now)).toBeNull()
    // A fresh controller (new browser session) still hides the dismissed notice.
    const reloaded = new NoticeController(apiReturning({ ...VIEW, text: '新的通知' }))
    expect(selectVisibleNotice(reloaded.state.getSnapshot(), now)).toBeNull()
    await reloaded.refresh()
    // A text change re-shows the banner.
    expect(selectVisibleNotice(reloaded.state.getSnapshot(), now)).toEqual({ text: '新的通知', startAt: VIEW.startAt })
  })
  it('ignores dismissal while no notice is showing', () => {
    const controller = new NoticeController(apiReturning(null))
    controller.dismiss()
    expect(readDismissedKey()).toBeNull()
    expect(controller.state.getSnapshot().dismissedKey).toBeNull()
  })
})
