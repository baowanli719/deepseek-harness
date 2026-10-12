/** Loopback proxy behavior against a real mock upstream server. */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  createGsLlmGatewayToken,
  GsLlmGatewayProxy,
  isGsLlmGatewayLoopbackAddress,
} from '../src/proxy.ts'

interface RecordedRequest {
  method: string | undefined
  url: string | undefined
  authorization: string | undefined
  contentType: string | undefined
  accept: string | undefined
  sensitive: string | undefined
  sessionId: string | undefined
  body: string
}

interface Upstream {
  readonly port: number
  readonly requests: RecordedRequest[]
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Start a mock gsclaw-server gateway; the handler answers after the body is drained. */
async function startUpstream(
  answer: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
): Promise<Upstream> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        accept: req.headers.accept,
        sensitive: req.headers['x-gsclaw-sensitive'] as string | undefined,
        sessionId: req.headers['x-session-id'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      answer(req, res, Buffer.concat(chunks))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  cleanups.push(() => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
    server.closeIdleConnections()
  }))
  return { port: (server.address() as AddressInfo).port, requests }
}

function jsonAnswer(status: number, payload: unknown, headers: Record<string, string> = {}) {
  return (_req: IncomingMessage, res: ServerResponse, _body: Buffer): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(payload))
  }
}

const REAL_TOKEN = 'real-access-token'

interface ProxyFixture {
  proxy: GsLlmGatewayProxy
  errors: string[]
}

/** Start the proxy in front of the mock upstream through a gsServer.fetch mimic. */
async function startProxy(options: {
  upstream: Upstream
  accessToken?: string | undefined
  maxBodyBytes?: number
  isPrivateSession?: (sessionId: string) => boolean
}): Promise<ProxyFixture> {
  const errors: string[] = []
  const accessToken = 'accessToken' in options ? options.accessToken : REAL_TOKEN
  const proxy = new GsLlmGatewayProxy({
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    accessToken: () => Promise.resolve(accessToken),
    ...options.isPrivateSession === undefined ? {} : { isPrivateSession: options.isPrivateSession },
    // Mimics gsServer.fetch: endpoint resolution plus Bearer attachment.
    upstream: (path, init) => {
      const headers = new Headers(init.headers)
      headers.set('authorization', `Bearer ${accessToken}`)
      return fetch(`http://127.0.0.1:${String(options.upstream.port)}${path}`, { ...init, headers })
    },
    onError: (line) => { errors.push(line) },
  })
  await proxy.start()
  cleanups.push(() => proxy.close())
  return { proxy, errors }
}

function completions(proxy: GsLlmGatewayProxy, init: RequestInit = {}, provider = 'gs-cloud'): Promise<Response> {
  return fetch(`${proxy.origin}/v1/${provider}/chat/completions`, init)
}

function authedPost(proxy: GsLlmGatewayProxy, body: string, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json', ...headers },
    body,
  }
}

describe('GsLlmGatewayProxy', () => {
  it('forwards internal vision requests without a client model selection', async () => {
    const upstream = await startUpstream(jsonAnswer(200, { ok: true }))
    const { proxy } = await startProxy({ upstream })
    const response = await fetch(`${proxy.origin}/vision/chat/completions`, authedPost(proxy, '{"messages":[]}'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(upstream.requests[0]!.url).toBe('/api/v1/llm/vision/chat/completions')
    expect(upstream.requests[0]!.authorization).toBe(`Bearer ${REAL_TOKEN}`)
    expect(upstream.requests[0]!.body).toBe('{"messages":[]}')
    // Vision has no session affinity here, so the gateway must conservatively mark it private.
    expect(upstream.requests[0]?.sensitive).toBe('1')
  })

  it('forwards the request upstream with the real access token, never the boot token', async () => {
    const upstream = await startUpstream(jsonAnswer(200, { ok: true }))
    const { proxy } = await startProxy({ upstream })

    const response = await completions(proxy, authedPost(proxy, '{"model":"qwen","messages":[]}'), 'gs-cloud')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(upstream.requests).toHaveLength(1)
    const recorded = upstream.requests[0]!
    expect(recorded.method).toBe('POST')
    expect(recorded.url).toBe('/api/v1/llm/gs-cloud/v1/chat/completions')
    expect(recorded.authorization).toBe(`Bearer ${REAL_TOKEN}`)
    expect(recorded.authorization).not.toContain(proxy.token)
    expect(recorded.contentType).toBe('application/json')
    expect(recorded.body).toBe('{"model":"qwen","messages":[]}')
  })

  it('streams SSE answers through without buffering', async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"delta":"a"}\n\n')
      setTimeout(() => {
        res.write('data: {"delta":"b"}\n\n')
        res.end()
      }, 20)
    })
    const { proxy } = await startProxy({ upstream })

    const response = await completions(proxy, authedPost(proxy, '{}', { accept: 'text/event-stream' }))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toBe('data: {"delta":"a"}\n\ndata: {"delta":"b"}\n\n')
    expect(upstream.requests[0]?.accept).toBe('text/event-stream')
  })

  it('refuses requests without the boot token or with a wrong one', async () => {
    const upstream = await startUpstream(jsonAnswer(200, {}))
    const { proxy } = await startProxy({ upstream })

    const missing = await completions(proxy, { method: 'POST', body: '{}' })
    expect(missing.status).toBe(403)
    const wrong = await completions(proxy, {
      method: 'POST',
      headers: { authorization: `Bearer ${createGsLlmGatewayToken()}` },
      body: '{}',
    })
    expect(wrong.status).toBe(403)
    const malformed = await completions(proxy, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-token' },
      body: '{}',
    })
    expect(malformed.status).toBe(403)
    expect(upstream.requests).toHaveLength(0)
  })

  it('accepts POST only and known provider routes only', async () => {
    const upstream = await startUpstream(jsonAnswer(200, {}))
    const { proxy } = await startProxy({ upstream })

    const get = await fetch(`${proxy.origin}/v1/gs-cloud/chat/completions`, {
      headers: { authorization: `Bearer ${proxy.token}` },
    })
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')

    const unknown = await completions(proxy, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}` },
      body: '{}',
    }, 'no%2Fsuch')
    expect(unknown.status).toBe(404)
    const unrouted = await fetch(`${proxy.origin}/v1/gs-cloud/completions`, authedPost(proxy, '{}'))
    expect(unrouted.status).toBe(404)
    expect(upstream.requests).toHaveLength(0)
  })

  it('answers 413 when the request body exceeds the configured cap', async () => {
    const upstream = await startUpstream(jsonAnswer(200, {}))
    const { proxy } = await startProxy({ upstream, maxBodyBytes: 16 })

    const response = await completions(proxy, authedPost(proxy, 'x'.repeat(64)))

    expect(response.status).toBe(413)
    expect(upstream.requests).toHaveLength(0)
  })

  it('answers 401 without touching the upstream while no session is signed in', async () => {
    const upstream = await startUpstream(jsonAnswer(200, {}))
    const { proxy } = await startProxy({ upstream, accessToken: undefined })

    const response = await completions(proxy, authedPost(proxy, '{}'))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: { message: 'not signed in to gsclaw-server', type: 'authentication_error' },
    })
    expect(upstream.requests).toHaveLength(0)
  })

  it('passes an upstream 401 through untouched; the refresh-retry belongs to gsServer.fetch', async () => {
    const upstream = await startUpstream(jsonAnswer(401, { error: 'expired' }, { 'retry-after': '3' }))
    const { proxy } = await startProxy({ upstream })

    const response = await completions(proxy, authedPost(proxy, '{}'))

    expect(response.status).toBe(401)
    expect(response.headers.get('retry-after')).toBe('3')
    expect(await response.json()).toEqual({ error: 'expired' })
    expect(upstream.requests).toHaveLength(1)
  })

  it('answers 502 when the upstream request fails', async () => {
    const errors: string[] = []
    const proxy = new GsLlmGatewayProxy({
      maxBodyBytes: 1024,
      accessToken: () => Promise.resolve(REAL_TOKEN),
      upstream: () => Promise.reject(new Error('connect ECONNREFUSED')),
      onError: (line) => { errors.push(line) },
    })
    await proxy.start()
    cleanups.push(() => proxy.close())

    const response = await completions(proxy, authedPost(proxy, '{}'))

    expect(response.status).toBe(502)
    expect(errors.some(line => line.includes('ECONNREFUSED'))).toBe(true)
  })

  it('stamps the sensitive audit header on a private session request, judged from the session-id header', async () => {
    const upstream = await startUpstream(jsonAnswer(200, { ok: true }))
    const { proxy } = await startProxy({ upstream, isPrivateSession: id => id === 's-private' })

    const response = await completions(proxy, authedPost(proxy, '{}', { 'x-session-id': 's-private' }))

    expect(response.status).toBe(200)
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]?.sensitive).toBe('1')
    // The session binding stays on the loopback hop.
    expect(upstream.requests[0]?.sessionId).toBeUndefined()
  })

  it('omits the audit header for standard sessions, header-less requests, and without a policy judgement', async () => {
    const upstream = await startUpstream(jsonAnswer(200, { ok: true }))
    const { proxy } = await startProxy({ upstream, isPrivateSession: () => false })

    await completions(proxy, authedPost(proxy, '{}', { 'x-session-id': 's-standard' }))
    await completions(proxy, authedPost(proxy, '{}'))

    expect(upstream.requests).toHaveLength(2)
    expect(upstream.requests[0]?.sensitive).toBeUndefined()
    expect(upstream.requests[1]?.sensitive).toBeUndefined()

    const noJudgement = await startProxy({ upstream })
    await completions(noJudgement.proxy, authedPost(noJudgement.proxy, '{}', { 'x-session-id': 's-private' }))
    expect(upstream.requests[2]?.sensitive).toBeUndefined()
  })

  it('never forwards a forged inbound audit header', async () => {
    const upstream = await startUpstream(jsonAnswer(200, { ok: true }))
    const { proxy } = await startProxy({ upstream, isPrivateSession: () => false })

    await completions(proxy, authedPost(proxy, '{}', {
      'x-session-id': 's-standard',
      'x-gsclaw-sensitive': '1',
    }))

    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0]?.sensitive).toBeUndefined()
  })

  it('owns its port through teardown: origin works only while started', async () => {
    const upstream = await startUpstream(jsonAnswer(200, {}))
    const { proxy } = await startProxy({ upstream })
    const origin = proxy.origin

    await proxy.close()
    await proxy.close()

    await expect(fetch(`${origin}/v1/gs-cloud/chat/completions`, authedPost(proxy, '{}'))).rejects.toThrow()
    expect(() => proxy.origin).toThrow('not listening')
  })

  it('validates provider ids and the boot token shape', async () => {
    const upstream = await startUpstream(jsonAnswer(200, {}))
    const { proxy } = await startProxy({ upstream })

    expect(proxy.providerBaseUrl('gs-cloud')).toBe(`${proxy.origin}/v1/gs-cloud`)
    expect(() => proxy.providerBaseUrl('bad/id')).toThrow('route grammar')
    expect(() => new GsLlmGatewayProxy({
      token: 'short',
      maxBodyBytes: 1024,
      accessToken: () => Promise.resolve(undefined),
      upstream: () => Promise.reject(new Error('unreachable')),
    })).toThrow('32 base64url bytes')
    expect(isGsLlmGatewayLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isGsLlmGatewayLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isGsLlmGatewayLoopbackAddress('10.0.0.2')).toBe(false)
    expect(isGsLlmGatewayLoopbackAddress(undefined)).toBe(false)
  })
})
