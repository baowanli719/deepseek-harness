/** GS-authenticated source proxy; credentials never leave the Host. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { GatewayError, isSameOriginLoopbackRequest } from '@deepseek-ai/dsh-gs-server'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Bounds for user-requested source reads, independent of model tool output. */
export interface Config {
  /** Maximum uncompressed upstream response bytes. @default 2097152 */
  maxResponseBytes: number
  /** Maximum duration of a source read, including body consumption. @default 120000 */
  requestTimeoutMs: number
}
export const Config: z<Config> = z.object({
  maxResponseBytes: z.natural().min(1).default(2 * 1024 * 1024),
  requestTimeoutMs: z.natural().min(1).max(2_147_483_647).default(120_000),
})
export const inject = ['gsServer', 'webServer']

/**
 * Resolve a policy-source URL against the active GS endpoint before attaching credentials.
 * @param value - untrusted link from the browser.
 * @param endpoint - Host-configured GS endpoint, including its deployment prefix.
 * @returns fixed API path, or undefined for an unrecognized destination.
 */
function sourcePath(value: string, endpoint: string): string | undefined {
  let url: URL
  try { url = new URL(value) } catch { return undefined }
  const base = new URL(endpoint)
  const prefix = `${base.pathname.replace(/\/$/u, '')}/api/v1/zhidu/files/`
  if (url.origin !== base.origin || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || !url.pathname.startsWith(prefix)) return undefined
  const fileId = url.pathname.slice(prefix.length)
  return /^\d{1,25}$/u.test(fileId) ? `/api/v1/zhidu/files/${fileId}` : undefined
}

async function readText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const abort = (): void => { void reader.cancel().catch((_error: unknown) => { /* The transport may already have aborted. */ }) }
  signal.addEventListener('abort', abort, { once: true })
  let bytes = 0
  let text = ''
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error('source response exceeds configured byte limit')
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch((_error: unknown) => { /* The request may already have closed the stream. */ })
    reader.releaseLock()
  }
}

/** @param ctx - Host with GS credentials and loopback HTTP. @param config - source read bounds. */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/gs-server/link-preview',
    handler: async (req, res) => {
      const finish = (status: number, value: object): void => {
        res.statusCode = status
        res.setHeader('cache-control', 'no-store')
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('x-content-type-options', 'nosniff')
        res.end(JSON.stringify(value))
      }
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        finish(405, { error: 'method not allowed' })
        return
      }
      const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
      if (!isSameOriginLoopbackRequest(req, origin, false)) {
        finish(403, { error: 'forbidden' })
        return
      }
      const session = ctx.gsServer.sessionView()
      const value = new URL(req.url ?? '/', origin).searchParams.get('url')
      const path = value === null ? undefined : sourcePath(value, session.endpoint)
      if (path === undefined) {
        finish(409, { code: 'source_endpoint_mismatch', error: 'source does not belong to the active GS endpoint' })
        return
      }
      if (session.status !== 'signed-in') {
        finish(401, { error: 'not signed in' })
        return
      }
      const controller = new AbortController()
      const abort = (): void => { controller.abort() }
      res.on('close', abort)
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(config.requestTimeoutMs)])
      try {
        const response = await ctx.gsServer.fetch(path, { method: 'GET', redirect: 'error', cache: 'no-store', signal })
        if (!response.ok) {
          await response.body?.cancel()
          finish([401, 403, 404].includes(response.status) ? response.status : 502, { error: 'source request failed' })
          return
        }
        const raw = await readText(response, config.maxResponseBytes, signal)
        let parsed: unknown
        try { parsed = JSON.parse(raw) } catch (_error) { /* Non-JSON responses remain literal source text. */ }
        const row = typeof parsed === 'object' && parsed !== null ? parsed : undefined
        finish(200, {
          fileName: row !== undefined && 'fileName' in row && typeof row.fileName === 'string' ? row.fileName : null,
          content: row !== undefined && 'content' in row && typeof row.content === 'string' ? row.content : raw,
          truncated: row !== undefined && 'truncated' in row && row.truncated === true,
        })
      } catch (error) {
        if (!controller.signal.aborted) {
          finish(error instanceof GatewayError && [401, 403].includes(error.status) ? error.status : 502,
            { error: 'source unavailable' })
        }
      } finally {
        res.off('close', abort)
      }
    },
  }), 'gs link-preview: authenticated source route')
}
