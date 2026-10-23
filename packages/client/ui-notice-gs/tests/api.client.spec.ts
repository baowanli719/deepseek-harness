/**
 * Loopback call layer: relative same-origin GET, error-envelope parsing, and
 * wire validation of the notice response.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNoticeApi, NoticeRequestError, parseNoticeResponse } from '../src/client/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(handler: () => Response | Promise<Response>) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    void init
    return Promise.resolve(handler())
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const NOTICE = {
  text: '系统维护通知',
  startAt: '2026-01-01T00:00:00.000Z',
  endAt: '2026-01-02T00:00:00.000Z',
  dismissible: false,
}

describe('createNoticeApi', () => {
  it('gets the notice from the loopback notice route', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { notice: NOTICE }))
    const api = createNoticeApi()
    const view = await api.fetchNotice()
    expect(view).toEqual(NOTICE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = fetchMock.mock.calls[0]!
    expect(path).toBe('api/gs-server/notice')
    expect(init?.method).toBe('GET')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.redirect).toBe('error')
    expect(init?.cache).toBe('no-store')
    expect(init?.body).toBeUndefined()
  })

  it('returns null when the server disables the banner', async () => {
    stubFetch(() => jsonResponse(200, { notice: null }))
    const api = createNoticeApi()
    await expect(api.fetchNotice()).resolves.toBeNull()
  })

  it('raises the server error envelope with status and message', async () => {
    stubFetch(() => jsonResponse(503, { error: '服务异常' }))
    const api = createNoticeApi()
    const failure = await api.fetchNotice().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(NoticeRequestError)
    const error = failure as NoticeRequestError
    expect(error.message).toBe('服务异常')
    expect(error.status).toBe(503)
  })

  it('keeps the empty message on a non-JSON failure body', async () => {
    stubFetch(() => Promise.resolve(new Response('oops', { status: 502 })))
    const api = createNoticeApi()
    const failure = await api.fetchNotice().catch((error: unknown) => error)
    expect((failure as NoticeRequestError).message).toBe('')
    expect((failure as NoticeRequestError).status).toBe(502)
  })

  it('keeps the empty message when the failure envelope carries no error text', async () => {
    stubFetch(() => jsonResponse(500, { code: 'maintenance' }))
    const api = createNoticeApi()
    const failure = await api.fetchNotice().catch((error: unknown) => error)
    expect((failure as NoticeRequestError).message).toBe('')
  })

  it('surfaces an invalid success body as a validation error', async () => {
    stubFetch(() => jsonResponse(200, { notice: { text: '' } }))
    const api = createNoticeApi()
    await expect(api.fetchNotice()).rejects.toThrow('invalid notice response')
  })
})

describe('wire validation', () => {
  it('accepts a minimal notice and drops absent optional fields', () => {
    expect(parseNoticeResponse({ notice: { text: '例行巡检' } })).toEqual({ text: '例行巡检' })
  })

  it('rejects non-object envelopes and a missing notice field', () => {
    expect(() => parseNoticeResponse(null)).toThrow('invalid notice response')
    expect(() => parseNoticeResponse([])).toThrow('invalid notice response')
    expect(() => parseNoticeResponse('notice')).toThrow('invalid notice response')
    expect(() => parseNoticeResponse({})).toThrow('invalid notice response')
  })

  it('rejects malformed notice fields', () => {
    expect(() => parseNoticeResponse({ notice: 'text' })).toThrow('invalid notice response')
    expect(() => parseNoticeResponse({ notice: { text: 1 } })).toThrow('invalid notice response')
    expect(() => parseNoticeResponse({ notice: { text: '' } })).toThrow('invalid notice response')
    expect(() => parseNoticeResponse({ notice: { text: 'x', startAt: 1 } })).toThrow('invalid notice response')
    expect(() => parseNoticeResponse({ notice: { text: 'x', endAt: true } })).toThrow('invalid notice response')
    expect(() => parseNoticeResponse({ notice: { text: 'x', dismissible: 'yes' } })).toThrow('invalid notice response')
  })
})
