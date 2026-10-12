/** Gateway client: envelope normalization, byte caps, and the 401 refresh retry. */
import { expect, it, vi } from 'vitest'
import {
  authorizedFetch,
  authorizedJson,
  GatewayError,
  gsJsonRequest,
  type GsRequest,
  type GsSessionTokenSource,
} from '../src/client.ts'

const ENDPOINT = 'http://127.0.0.1:8151/gsworker'

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function session(token = 'access-1', refresh?: () => Promise<string>): GsSessionTokenSource {
  return {
    accessToken: () => token,
    refreshAccessToken: refresh ?? vi.fn<() => Promise<string>>().mockResolvedValue('access-2'),
  }
}

it('parses the legacy { error, message } envelope', async () => {
  const request: GsRequest = async () => jsonResponse(403, { error: 'forbidden', message: 'nope' })
  const failure = await gsJsonRequest({ endpoint: ENDPOINT, path: '/api/x', request }).catch((e: unknown) => e)
  expect(failure).toBeInstanceOf(GatewayError)
  expect(failure).toMatchObject({ code: 'forbidden', status: 403, message: 'nope' })
})

it('parses the /api/v1 { code, message, traceId } envelope and Retry-After', async () => {
  const request: GsRequest = async () => jsonResponse(429,
    { code: 'too_many_requests', message: 'slow down', traceId: 'trace-1' }, { 'retry-after': '7' })
  const failure = await gsJsonRequest({ endpoint: ENDPOINT, path: '/api/v1/x', request }).catch((e: unknown) => e)
  expect(failure).toMatchObject({ code: 'too_many_requests', status: 429, traceId: 'trace-1', retryAfter: 7 })
})

it('maps transport failures to a status-0 network error and malformed JSON to bad_response', async () => {
  const down: GsRequest = async () => { throw new TypeError('connect ECONNREFUSED') }
  const failure = await gsJsonRequest({ endpoint: ENDPOINT, path: '/api/x', request: down }).catch((e: unknown) => e)
  expect(failure).toMatchObject({ code: 'network', status: 0 })

  const garbage: GsRequest = async () => new Response('not json', { status: 200 })
  const bad = await gsJsonRequest({ endpoint: ENDPOINT, path: '/api/x', request: garbage }).catch((e: unknown) => e)
  expect(bad).toMatchObject({ code: 'bad_response', status: 200 })
})

it('enforces the response byte cap from a declared content-length', async () => {
  const request: GsRequest = async () => new Response('x', {
    status: 200,
    headers: { 'content-length': '1048577' },
  })
  const failure = await gsJsonRequest({ endpoint: ENDPOINT, path: '/api/x', request }).catch((e: unknown) => e)
  expect(failure).toMatchObject({ code: 'response_too_large', status: 200 })
})

it('sends the policy version header and a JSON body by default POST', async () => {
  const seen: { url?: string; init?: RequestInit } = {}
  const request: GsRequest = async (url, init) => {
    seen.url = url
    seen.init = init
    return jsonResponse(200, { ok: true })
  }
  await gsJsonRequest({ endpoint: ENDPOINT, path: '/api/x', body: { a: 1 }, request })
  expect(seen.url).toBe(`${ENDPOINT}/api/x`)
  expect(seen.init?.method).toBe('POST')
  expect(new Headers(seen.init?.headers).get('x-gsclaw-policy-version')).toBe('1')
  expect(seen.init?.body).toBe('{"a":1}')
})

it('retries exactly once after a refreshable 401 through the single-flight refresh', async () => {
  const calls: string[] = []
  const request: GsRequest = async (_url, init) => {
    const auth = new Headers(init.headers).get('authorization') ?? ''
    calls.push(auth)
    if (auth === 'Bearer access-1') return jsonResponse(401, { code: 'token_expired', message: 'expired' })
    return jsonResponse(200, { ok: true })
  }
  const refresh = vi.fn<() => Promise<string>>().mockResolvedValue('access-2')
  const result = await authorizedJson<{ ok: boolean }>({ endpoint: ENDPOINT, path: '/api/x', session: session('access-1', refresh), request })
  expect(result).toEqual({ ok: true })
  expect(calls).toEqual(['Bearer access-1', 'Bearer access-2'])
  expect(refresh).toHaveBeenCalledExactlyOnceWith()
})

it('rethrows a non-refreshable 401 without refreshing', async () => {
  const request: GsRequest = async () => jsonResponse(401, { code: 'permission_denied', message: 'denied' })
  const refresh = vi.fn<() => Promise<string>>().mockResolvedValue('access-2')
  const failure = await authorizedJson({ endpoint: ENDPOINT, path: '/api/x', session: session('access-1', refresh), request })
    .catch((e: unknown) => e)
  expect(failure).toMatchObject({ code: 'permission_denied', status: 401 })
  expect(refresh).not.toHaveBeenCalled()
})

it('fails signed-out requests before any traffic', async () => {
  const request: GsRequest = vi.fn<GsRequest>()
  const signedOut: GsSessionTokenSource = { accessToken: () => undefined, refreshAccessToken: () => Promise.resolve('x') }
  const failure = await authorizedJson({ endpoint: ENDPOINT, path: '/api/x', session: signedOut, request }).catch((e: unknown) => e)
  expect(failure).toMatchObject({ code: 'unauthorized', status: 401 })
  expect(request).not.toHaveBeenCalled()
})

it('authorizedFetch returns the raw response and refreshes once on an expired-token 401', async () => {
  const calls: string[] = []
  const request: GsRequest = async (_url, init) => {
    const headers = new Headers(init.headers)
    calls.push(headers.get('authorization') ?? '')
    expect(headers.get('x-gsclaw-policy-version')).toBe('1')
    if (calls.length === 1) return jsonResponse(401, { code: 'token_invalid', message: 'bad token' })
    return new Response('raw-body', { status: 200 })
  }
  const refresh = vi.fn<() => Promise<string>>().mockResolvedValue('access-2')
  const response = await authorizedFetch({
    endpoint: ENDPOINT, path: '/api/stream', session: session('access-1', refresh), request,
    init: { headers: { accept: 'text/event-stream' } },
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('raw-body')
  expect(calls).toEqual(['Bearer access-1', 'Bearer access-2'])
})

it('authorizedFetch returns a non-refreshable 401 verbatim with its body intact', async () => {
  const request: GsRequest = async () => jsonResponse(401, { code: 'permission_denied', message: 'denied' })
  const refresh = vi.fn<() => Promise<string>>().mockResolvedValue('access-2')
  const response = await authorizedFetch({ endpoint: ENDPOINT, path: '/api/x', session: session('access-1', refresh), request })
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ code: 'permission_denied' })
  expect(refresh).not.toHaveBeenCalled()
})
