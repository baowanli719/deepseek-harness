// @vitest-environment jsdom
/** Policy source transport stays on the same-origin Host; no gateway token enters the browser. */
import { afterEach, expect, it, vi } from 'vitest'
import { createGsLinkPreviewProvider } from '../src/client/link-preview.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('recognizes制度 IDs as strings and passes cancellation through the Host request', async () => {
  const provider = createGsLinkPreviewProvider()
  const url = 'https://gs.test/gsclaw/api/v1/zhidu/files/1234567890123456789'
  expect(provider.accepts(new URL(url))).toBe(true)
  for (const invalid of [url + '?token=x', url + '#a', url + '/extra', url.replace('1234567890123456789', 'uuid')]) {
    expect(provider.accepts(new URL(invalid))).toBe(false)
  }
  const request = vi.fn(async () => Response.json({ fileName: '制度', content: '{未格式化原文}', truncated: true }))
  vi.stubGlobal('fetch', request)
  const signal = new AbortController().signal
  expect(await provider.read(url, signal)).toEqual({ status: 'ok', document: { title: '制度', content: '{未格式化原文}', truncated: true } })
  expect(request).toHaveBeenCalledWith(`api/gs-server/link-preview?url=${encodeURIComponent(url)}`, {
    credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
  })
})

it.each([[401, 'unauthorized'], [403, 'forbidden'], [404, 'not-found'], [502, 'failed']] as const)(
  'maps HTTP %s to the shared reader outcome', async (status, expected) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status })))
    expect(await createGsLinkPreviewProvider().read('https://gs.test/api/v1/zhidu/files/1', new AbortController().signal))
      .toEqual({ status: expected })
  },
)

it('accepts an absent file title and rejects malformed wire responses', async () => {
  const request = vi.fn().mockResolvedValueOnce(Response.json({ fileName: null, content: '原文', truncated: false }))
    .mockResolvedValueOnce(Response.json({ content: 'missing fields' }))
  vi.stubGlobal('fetch', request)
  const provider = createGsLinkPreviewProvider()
  expect(await provider.read('https://gs.test/api/v1/zhidu/files/1', new AbortController().signal)).toMatchObject({
    status: 'ok', document: { title: null },
  })
  expect(await provider.read('https://gs.test/api/v1/zhidu/files/1', new AbortController().signal)).toEqual({ status: 'failed' })
})

it('distinguishes source-address mismatches from authorization failures and malformed conflict responses', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce(Response.json({ code: 'source_endpoint_mismatch' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ code: 'other' }, { status: 409 }))
    .mockResolvedValueOnce(Response.json(null, { status: 409 }))
    .mockResolvedValueOnce(new Response('not json', { status: 409 }))
  vi.stubGlobal('fetch', request)
  const provider = createGsLinkPreviewProvider()
  const signal = new AbortController().signal
  expect(await provider.read('https://gs.test/api/v1/zhidu/files/1', signal)).toEqual({ status: 'source-mismatch' })
  for (let i = 0; i < 3; i++) expect(await provider.read('https://gs.test/api/v1/zhidu/files/1', signal)).toEqual({ status: 'failed' })
})
