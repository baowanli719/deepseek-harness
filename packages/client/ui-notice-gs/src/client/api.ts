/**
 * Same-origin call to the Host's gs-server notice loopback route. The access
 * token stays in the Host; the renderer only speaks to the loopback path.
 * Server failures arrive as `{error}` and surface here as
 * {@link NoticeRequestError} with the server's message.
 */

import type { GsNoticeView } from './contract.ts'

// Loopback path mirrors GS_SERVER_NOTICE_PATH in dsh-gs-server, relative for
// the renderer's same-origin fetch.
const NOTICE_PATH = 'api/gs-server/notice'

/** One failed notice request: HTTP status and the server message when present. */
export class NoticeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'NoticeRequestError'
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function invalid(): Error {
  return new Error('invalid notice response')
}

/**
 * Validate one notice wire body into the view.
 * @param value - untrusted notice response body.
 * @returns the validated notice, or null when the server disables the banner.
 */
export function parseNoticeResponse(value: unknown): GsNoticeView | null {
  const row = record(value)
  if (row === undefined) throw invalid()
  if (row.notice === null) return null
  const notice = record(row.notice)
  if (notice === undefined || typeof notice.text !== 'string' || notice.text === '') throw invalid()
  if (notice.startAt !== undefined && typeof notice.startAt !== 'string') throw invalid()
  if (notice.endAt !== undefined && typeof notice.endAt !== 'string') throw invalid()
  if (notice.dismissible !== undefined && typeof notice.dismissible !== 'boolean') throw invalid()
  return {
    text: notice.text,
    ...(typeof notice.startAt === 'string' ? { startAt: notice.startAt } : {}),
    ...(typeof notice.endAt === 'string' ? { endAt: notice.endAt } : {}),
    ...(typeof notice.dismissible === 'boolean' ? { dismissible: notice.dismissible } : {}),
  }
}

async function get<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    method: 'GET',
  })
  if (!response.ok) {
    // No fabricated copy: a failure without a server envelope carries an empty
    // message, and the caller keeps the previous banner instead.
    let fallback = ''
    try {
      const row = record(await response.json())
      if (typeof row?.error === 'string') fallback = row.error
    } catch (cause: unknown) {
      // A non-JSON failure body keeps the empty message.
      void cause
    }
    throw new NoticeRequestError(response.status, fallback)
  }
  return parse(await response.json())
}

/** Business face the banner controller consumes. */
export interface NoticeApi {
  /** Read the server's current notice; null hides the banner. */
  readonly fetchNotice: () => Promise<GsNoticeView | null>
}

/**
 * Build the loopback-backed API.
 * @returns the fetch-bound call set.
 */
export function createNoticeApi(): NoticeApi {
  return { fetchNotice: () => get(NOTICE_PATH, parseNoticeResponse) }
}
