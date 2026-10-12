/**
 * 127.0.0.1-only loopback proxy in front of the gsclaw-server model gateway.
 *
 * LLM adapters never talk to gsclaw-server directly: mirrored provider
 * profiles point at this server with a per-boot placeholder token as their
 * apiKey, and the proxy forwards each request through
 * `gsServer.fetch('/api/v1/llm/{providerId}/v1/chat/completions')`, which
 * attaches the real in-memory access token, refreshes single-flight on 401,
 * and retries exactly once. Bodies stream both ways, so SSE answers reach the
 * adapter without buffering. Inbound client headers are never forwarded, so
 * the placeholder token cannot leak upstream; the one inbound header the
 * proxy reads is the session-affinity `x-session-id` the mirrored profiles
 * switch on, re-judged through `isPrivateSession` to stamp the
 * `x-gsclaw-sensitive` audit header on a private session's upstream request.
 *
 * Abuse surface: the listener binds loopback only, every request must carry
 * the boot token as `Authorization: Bearer …`, and the token never leaves
 * process memory — mirrored profiles carry only the credential *reference*
 * the token resolves through.
 *
 * @module dsh-llm-gs-gateway/proxy
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { GS_SENSITIVE_SESSION_HEADER, GS_SENSITIVE_SESSION_HEADER_VALUE } from '@deepseek-ai/dsh-gs-server'

const BIN_NAME = 'llm-gs-gateway'

/**
 * Inbound header carrying the agent session id on the loopback hop. The
 * mirrored provider profiles (models.ts) turn on pi-ai's session-affinity
 * emission in the single-header `openrouter` format, so every session-bound
 * adapter request arrives with it; the proxy reads it for the audit-header
 * judgement and never forwards it upstream. Protocol constant of this package.
 */
export const GS_LLM_GATEWAY_SESSION_ID_HEADER = 'x-session-id'

/** Boot-token shape: 32 random bytes, base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

/** Provider route grammar accepted in proxy URLs and stamped into provider profiles. */
export const GS_LLM_GATEWAY_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

const ROUTE_PATTERN = /^\/v1\/([^/]+)\/chat\/completions$/u

/** Mint one unpredictable per-boot placeholder token.
 * @returns 32 random bytes in base64url, matching the proxy's token grammar.
 */
export function createGsLlmGatewayToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Whether one peer address belongs to the loopback host.
 * @param address - socket remote address to judge.
 * @returns whether the peer is loopback.
 */
export function isGsLlmGatewayLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Inputs for the loopback LLM gateway proxy. */
export interface GsLlmGatewayProxyOptions {
  /** Resolve the real access token per request; `undefined` answers 401 without touching the upstream. */
  readonly accessToken: () => Promise<string | undefined>
  /**
   * Authenticated upstream request, typically `gsServer.fetch`: it resolves
   * the endpoint, attaches the Bearer token, and owns the 401 refresh-retry.
   */
  readonly upstream: (path: string, init: RequestInit) => Promise<Response>
  /** Maximum chat-completions request body the proxy accepts. */
  readonly maxBodyBytes: number
  /**
   * Privacy judgement for the audit header: a request whose inbound
   * {@link GS_LLM_GATEWAY_SESSION_ID_HEADER} names a private session forwards
   * with `x-gsclaw-sensitive: 1`. Absent (or answering `false`), no audit
   * header is added; the sensitive-policy plugin supplies the real judgement.
   */
  readonly isPrivateSession?: (sessionId: string) => boolean
  /** Boot token; defaults to a fresh random one. */
  readonly token?: string
  /** Sink for unexpected per-request failures that cannot reach the client. */
  readonly onError?: (line: string) => void
}

function writeJson(res: ServerResponse, status: number, type: string, message: string): void {
  if (res.destroyed || res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify({ error: { message, type } }))
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (actual === undefined || !TOKEN_PATTERN.test(actual) || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}

/**
 * 127.0.0.1-only HTTP proxy swapping the per-boot placeholder token for the
 * authenticated `gsServer.fetch` channel. One instance serves one plugin
 * mount; `start` picks a random port and `origin` feeds the mirrored
 * provider profiles. Implements the public {@link GsLlmGateway} face.
 */
export class GsLlmGatewayProxy {
  /** Per-boot placeholder token the provider profiles name through their credential reference. */
  readonly token: string
  private readonly options: GsLlmGatewayProxyOptions
  private server: Server | undefined
  private boundPort: number | undefined

  constructor(options: GsLlmGatewayProxyOptions) {
    const token = options.token ?? createGsLlmGatewayToken()
    if (!TOKEN_PATTERN.test(token)) {
      throw new TypeError(`${BIN_NAME}: gateway proxy token must be 32 base64url bytes`)
    }
    if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes <= 0) {
      throw new TypeError(`${BIN_NAME}: gateway proxy maxBodyBytes must be a positive safe integer`)
    }
    this.token = token
    this.options = options
  }

  /** Loopback origin of the running proxy; throws before `start` settles. */
  get origin(): string {
    if (this.boundPort === undefined) {
      throw new Error(`${BIN_NAME}: gateway proxy is not listening yet`)
    }
    return `http://127.0.0.1:${String(this.boundPort)}`
  }

  /** Provider-profile baseURL route for one server provider id.
   * @param providerId - provider id inside the proxy route grammar.
   * @returns the loopback baseURL naming that provider.
   */
  providerBaseUrl(providerId: string): string {
    if (!GS_LLM_GATEWAY_PROVIDER_ID_PATTERN.test(providerId)) {
      throw new Error(`${BIN_NAME}: LLM provider id ${JSON.stringify(providerId)} is outside the proxy route grammar`)
    }
    return `${this.origin}/v1/${providerId}`
  }

  /** Bind the loopback listener on a random port. */
  async start(): Promise<void> {
    if (this.server !== undefined) {
      throw new Error(`${BIN_NAME}: gateway proxy is already started`)
    }
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((cause: unknown) => {
        const line = `${BIN_NAME}: gateway proxy request failed: ${cause instanceof Error ? cause.message : String(cause)}`
        this.options.onError?.(line)
        if (!res.headersSent) writeJson(res, 500, 'server_error', 'LLM gateway proxy failure')
        if (!res.writableEnded) res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.boundPort = (server.address() as AddressInfo).port
    this.server = server
  }

  /** Stop accepting connections and drain idle ones; in-flight streams end with their sockets. */
  async close(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    this.boundPort = undefined
    await new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeIdleConnections()
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isGsLlmGatewayLoopbackAddress(req.socket.remoteAddress)) {
      writeJson(res, 403, 'permission_error', 'LLM gateway proxy accepts loopback connections only')
      return
    }
    const authorization = req.headers.authorization
    const presented = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined
    if (!sameToken(presented, this.token)) {
      writeJson(res, 403, 'permission_error', 'LLM gateway proxy request carries no valid boot token')
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      writeJson(res, 405, 'invalid_request_error', 'LLM gateway proxy route accepts POST only')
      return
    }
    const visionRequest = req.url === '/vision/chat/completions'
    const route = ROUTE_PATTERN.exec(req.url ?? '')
    const providerId = route?.[1] === undefined ? undefined : decodeURIComponent(route[1])
    if (!visionRequest && (providerId === undefined || !GS_LLM_GATEWAY_PROVIDER_ID_PATTERN.test(providerId))) {
      writeJson(res, 404, 'invalid_request_error', 'unknown LLM gateway proxy route')
      return
    }
    const body = await this.readBody(req, res)
    if (body === undefined) return
    const accessToken = await this.options.accessToken()
    if (accessToken === undefined) {
      writeJson(res, 401, 'authentication_error', 'not signed in to gsclaw-server')
      return
    }
    const sessionIdHeader = req.headers[GS_LLM_GATEWAY_SESSION_ID_HEADER]
    const sessionId = typeof sessionIdHeader === 'string' && sessionIdHeader !== '' ? sessionIdHeader : undefined
    await this.forward(visionRequest ? '/api/v1/llm/vision/chat/completions' : `/api/v1/llm/${encodeURIComponent(providerId ?? '')}/v1/chat/completions`, body, req, res, sessionId)
  }

  /** Read the bounded request body; answers 413 itself when the cap trips. */
  private async readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | undefined> {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of req) {
      bytes += (chunk as Buffer).byteLength
      if (bytes > this.options.maxBodyBytes) {
        req.pause()
        const socket = req.socket
        res.setHeader('connection', 'close')
        writeJson(res, 413, 'invalid_request_error', 'LLM gateway proxy request body is too large')
        res.on('finish', () => { socket.destroy() })
        return undefined
      }
      chunks.push(chunk as Buffer)
    }
    return Buffer.concat(chunks)
  }

  /**
   * Forward one buffered request through the authenticated upstream channel
   * and stream the answer — SSE and JSON alike — straight into the client
   * response. The upstream owns the expired-token refresh, so every status,
   * including a post-retry 401, passes through untouched. A private session's
   * request carries the `x-gsclaw-sensitive` audit header; the session id
   * itself stays on the loopback hop.
   */
  private async forward(
    upstreamPath: string,
    body: Buffer,
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string | undefined,
  ): Promise<void> {
    const abort = new AbortController()
    // `res` closes exactly once: prematurely on client disconnect, normally
    // after `res.end()`. Aborting on the former tears down the upstream read;
    // `writableEnded` tells the two apart. (`req` 'close' fires at message
    // completion since Node 16, so it cannot detect a disconnect here.)
    const onClose = (): void => {
      if (!res.writableEnded) abort.abort()
    }
    res.on('close', onClose)
    let response: Response
    try {
      response = await this.options.upstream(
        upstreamPath,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Inbound client headers are never forwarded beyond the negotiated
            // accept, so the placeholder boot token cannot leak upstream.
            ...(typeof req.headers.accept === 'string' ? { accept: req.headers.accept } : {}),
            // The audit header is rebuilt from the policy judgement, never
            // from an inbound header, so a forged `x-gsclaw-sensitive` cannot
            // reach the server and a private session cannot shed it.
            ...(upstreamPath === '/api/v1/llm/vision/chat/completions'
              || sessionId !== undefined && this.options.isPrivateSession?.(sessionId) === true
              ? { [GS_SENSITIVE_SESSION_HEADER]: GS_SENSITIVE_SESSION_HEADER_VALUE }
              : {}),
          },
          body: new Uint8Array(body),
          cache: 'no-store',
          redirect: 'error',
          signal: abort.signal,
        },
      )
    } catch (cause) {
      if (!abort.signal.aborted) {
        writeJson(res, 502, 'server_error', 'gsclaw-server LLM gateway is unreachable')
        this.options.onError?.(
          `${BIN_NAME}: gateway proxy upstream request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
      return
    }

    const contentType = response.headers.get('content-type')
    const retryAfter = response.headers.get('retry-after')
    res.statusCode = response.status
    if (contentType !== null) res.setHeader('content-type', contentType)
    if (retryAfter !== null) res.setHeader('retry-after', retryAfter)
    res.setHeader('cache-control', 'no-store')
    res.flushHeaders()
    if (response.body === null) {
      res.end()
      return
    }
    const stream = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
    res.on('close', () => { stream.destroy() })
    stream.on('error', () => { res.end() })
    stream.pipe(res)
  }
}
