/** Server notice polling and per-reader dismissal; the banner subscribes through the snapshot store. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { NoticeApi } from './api.ts'
import type { GsNoticeView } from './contract.ts'

/** localStorage key holding the dismissed notice fingerprint. */
const DISMISSED_STORAGE_KEY = 'dsh.gs.notice.dismissed'

/** Controller state: the latest fetched notice and the dismissed fingerprint. */
export interface NoticeState {
  readonly view: GsNoticeView | null
  readonly dismissedKey: string | null
}

/**
 * Fingerprint of one notice for dismissal: a text or schedule change re-shows the banner.
 * @param view - notice to fingerprint.
 * @returns the dismissal key.
 */
export function noticeKey(view: GsNoticeView): string {
  return view.text + '\n' + (view.startAt ?? '')
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const time = Date.parse(value)
  // An unparseable schedule field imposes no limit rather than hiding the notice.
  return Number.isNaN(time) ? undefined : time
}

/**
 * Whether a notice is inside its display window at one instant.
 * @param view - notice to test.
 * @param now - current epoch milliseconds.
 * @returns true when `now` falls inside [startAt, endAt]; absent or unparseable fields impose no limit.
 */
export function isNoticeActive(view: GsNoticeView, now: number): boolean {
  const start = parseTime(view.startAt)
  if (start !== undefined && now < start) return false
  const end = parseTime(view.endAt)
  if (end !== undefined && now > end) return false
  return true
}

/**
 * Read the persisted dismissal fingerprint.
 * @returns the stored key, or null when nothing was dismissed or storage is unavailable.
 */
export function readDismissedKey(): string | null {
  try {
    return localStorage.getItem(DISMISSED_STORAGE_KEY)
  } catch (cause: unknown) {
    // Privacy modes may deny storage; dismissal then lasts only for this session.
    void cause
    return null
  }
}

/**
 * Persist the dismissal fingerprint.
 * @param key - fingerprint of the dismissed notice.
 */
export function writeDismissedKey(key: string): void {
  try {
    localStorage.setItem(DISMISSED_STORAGE_KEY, key)
  } catch (cause: unknown) {
    // Storage denial only weakens dismissal persistence across reloads.
    void cause
  }
}

/**
 * The banner to show at one instant.
 * @param state - controller snapshot.
 * @param now - current epoch milliseconds.
 * @returns the visible notice, or null when absent, dismissed, or outside its window.
 */
export function selectVisibleNotice(state: NoticeState, now: number): GsNoticeView | null {
  const view = state.view
  if (view === null || state.dismissedKey === noticeKey(view) || !isNoticeActive(view, now)) return null
  return view
}

/** Root-owned notice controller shared by the refresh timer and the banner. */
export class NoticeController {
  /** Latest fetched notice and the reader's dismissal fingerprint. */
  readonly state = createSnapshotStore<NoticeState>({ view: null, dismissedKey: readDismissedKey() })

  /** @param api - authenticated Host loopback notice call. */
  constructor(readonly api: NoticeApi) {}

  /** Poll the server once; a failure keeps the previous banner. */
  async refresh(): Promise<void> {
    try {
      const view = await this.api.fetchNotice()
      this.state.set({ view, dismissedKey: this.state.getSnapshot().dismissedKey })
    } catch (cause: unknown) {
      // A transient route failure keeps the last banner rather than flickering it away.
      void cause
    }
  }

  /** Dismiss the current notice for this reader until its fingerprint changes. */
  dismiss(): void {
    const view = this.state.getSnapshot().view
    if (view === null) return
    const key = noticeKey(view)
    writeDismissedKey(key)
    this.state.set({ view, dismissedKey: key })
  }
}
