/**
 * Server skill-execution client for the `/api/v1/skills/*` protocol, riding
 * the `ctx.gsServer.fetch` bridge: the bridge owns endpoint resolution, the
 * Bearer token, and the single-flight 401 refresh-and-retry, so the only
 * replay is the bridge's own; timeouts, disconnects, 5xx, and 429 responses
 * are never replayed here. Business failures keep their machine code and
 * traceId instead of collapsing into empty-data success.
 *
 * @module dsh-gs-server-skills/execution
 */

import { Buffer } from 'node:buffer'
import { GS_SENSITIVE_SESSION_HEADER, GS_SENSITIVE_SESSION_HEADER_VALUE } from '@deepseek-ai/dsh-gs-server'
import type { SkillBundleFile } from './bundle-cache.ts'
import type {
  GsServerMeta,
  GsSkillCatalogResponse,
  GsSkillDefinitionResponse,
  GsSkillExecuteRequest,
} from './contract.ts'
import type { GsServerBridge } from './types.ts'

/** Maximum response body bytes accepted from the gateway. */
export const MAX_GS_RESPONSE_BYTES = 1024 * 1024

/**
 * Maximum response body bytes accepted from the bundle files endpoint: the
 * files response carries base64 (~4/3 inflation) over the total bundle cap,
 * plus JSON framing.
 */
export const MAX_SKILL_FILES_RESPONSE_BYTES = 42 * 1024 * 1024

/** Client-side outcome code that never came from the server envelope. */
export const GS_SKILL_CLIENT_TIMEOUT_CODE = 'client_timeout'

/** Normalized gateway failure carrying the `/api/v1/*` `{ code, message, traceId }` envelope. */
export class GsSkillRequestError extends Error {
  constructor(
    /** Machine code from the envelope, or `http_<status>` as a fallback. */
    readonly code: string,
    /** HTTP status; zero marks a client-side transport failure. */
    readonly status: number,
    message: string,
    /** Server correlation id, when the envelope carried one. */
    readonly traceId?: string,
  ) {
    super(message)
    this.name = 'GsSkillRequestError'
  }
}

/** Normalized result of one `POST /api/v1/skills/:name/execute` call. */
export type GsSkillExecuteOutcome =
  | {
    readonly status: 'ok'
    readonly requestId: string
    readonly traceId: string
    /** Text blocks joined in order. */
    readonly text: string
    readonly truncated: boolean
  }
  | {
    readonly status: 'error'
    /** Server machine code, the gateway envelope code, or `client_timeout`. */
    readonly code: string
    readonly message: string
    readonly traceId?: string
  }

/** Per-call controls shared by every method of the execution client. */
export interface GsSkillCallOptions {
  /** Caller-owned cancellation, forwarded to the fetch layer. */
  readonly signal?: AbortSignal
  /** Client-side ceiling for this call; omitted waits on the caller's signal alone. */
  readonly timeoutMs?: number
  /**
   * Marks the call as private-session traffic: the request carries the
   * `x-gsclaw-sensitive: 1` audit header. Only the gated lane sets it, after
   * its own private-session check.
   */
  readonly sensitive?: boolean
}

/** Inputs for the server skill-execution client. */
export interface GsSkillExecutionClientOptions {
  /** Authenticated fetch bridge; `ctx.gsServer.fetch` satisfies it. */
  readonly fetch: GsServerBridge['fetch']
  /** Client-side ceiling of one execute call when the caller sets no deadline. */
  readonly executeTimeoutMs: number
}

/** Combined caller cancellation and an optional client-side timeout. */
interface LinkedSignal {
  readonly signal: AbortSignal
  /** Whether the caller's own signal fired (as opposed to the timeout). */
  readonly callerAborted: () => boolean
  /** Whether the client-side timeout fired. */
  readonly timedOut: () => boolean
  readonly release: () => void
}

function linkSignal(options: GsSkillCallOptions): LinkedSignal {
  const controller = new AbortController()
  let timedOut = false
  const caller = options.signal
  const onCallerAbort = (): void => { controller.abort(caller?.reason) }
  if (caller !== undefined) {
    if (caller.aborted) controller.abort(caller.reason)
    else caller.addEventListener('abort', onCallerAbort, { once: true })
  }
  const timer = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
      timedOut = true
      controller.abort(new Error(`gsclaw-server skill execution timed out after ${String(options.timeoutMs)}ms`))
    }, options.timeoutMs)
  return {
    signal: controller.signal,
    callerAborted: () => caller?.aborted === true,
    timedOut: () => timedOut,
    release: () => {
      if (timer !== undefined) clearTimeout(timer)
      caller?.removeEventListener('abort', onCallerAbort)
    },
  }
}

/** Bounded response body read; oversized payloads fail instead of buffering. */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(maxBytes)) {
    throw new GsSkillRequestError('response_too_large', response.status, 'gsclaw-server response is too large')
  }
  if (response.body === null) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new GsSkillRequestError('response_too_large', response.status, 'gsclaw-server response is too large')
    }
    return text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new GsSkillRequestError('response_too_large', response.status, 'gsclaw-server response is too large')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

/**
 * Parse one execute body, refusing malformed envelopes instead of guessing.
 * @param value - decoded response body.
 * @returns the normalized outcome.
 */
export function parseSkillExecuteResponse(value: unknown): GsSkillExecuteOutcome {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GsSkillRequestError('bad_response', 200, 'gsclaw-server returned a malformed execute response')
  }
  const record = value as Record<string, unknown>
  const traceId = typeof record.traceId === 'string' ? record.traceId : ''
  if (record.status === 'ok') {
    if (!Array.isArray(record.content)
      || record.content.some(block => typeof block !== 'object' || block === null
        || (block as { type?: unknown }).type !== 'text'
        || typeof (block as { text?: unknown }).text !== 'string')) {
      throw new GsSkillRequestError('bad_response', 200, 'gsclaw-server returned a malformed execute response')
    }
    return {
      status: 'ok',
      requestId: typeof record.requestId === 'string' ? record.requestId : '',
      traceId,
      text: (record.content as readonly { text: string }[]).map(block => block.text).join('\n'),
      truncated: record.truncated === true,
    }
  }
  const error = typeof record.error === 'object' && record.error !== null
    ? record.error as { code?: unknown; message?: unknown }
    : undefined
  return {
    status: 'error',
    code: typeof error?.code === 'string' ? error.code : 'execution_failed',
    message: typeof error?.message === 'string' ? error.message : 'gsclaw-server skill execution failed',
    ...(traceId === '' ? {} : { traceId }),
  }
}

/**
 * Validate one bundle files body field by field, refusing malformed documents
 * instead of guessing. Path safety, base64 strictness, and size limits are
 * enforced by the bundle cache at materialization time.
 * @param value - decoded response body.
 * @returns the validated bundle descriptor.
 */
export function parseSkillFilesResponse(
  value: unknown,
): { readonly name: string; readonly files: readonly SkillBundleFile[] } {
  const malformed = (): GsSkillRequestError =>
    new GsSkillRequestError('bad_response', 200, 'gsclaw-server returned a malformed files response')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed()
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || !Array.isArray(record.files)) throw malformed()
  const files: SkillBundleFile[] = []
  for (const entry of record.files as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw malformed()
    const file = entry as Record<string, unknown>
    if (typeof file.path !== 'string' || typeof file.base64 !== 'string') throw malformed()
    files.push({ path: file.path, base64: file.base64 })
  }
  return { name: record.name, files }
}

/**
 * Client for the server skill-execution protocol over the authenticated
 * fetch bridge. The access token never leaves the bridge: consumers only see
 * arguments and normalized results.
 */
export class GsSkillExecutionClient {
  constructor(private readonly options: GsSkillExecutionClientOptions) {}

  /**
   * One JSON request against the gateway; a non-OK status throws a
   * {@link GsSkillRequestError} carrying the envelope code and traceId.
   */
  private async request<T>(
    path: string,
    options: GsSkillCallOptions & {
      readonly method?: 'GET' | 'POST'
      readonly body?: unknown
      /** Response byte ceiling for this call; defaults to {@link MAX_GS_RESPONSE_BYTES}. */
      readonly maxBytes?: number
    } = {},
  ): Promise<T> {
    const linked = linkSignal(options)
    try {
      let response: Response
      try {
        const headers: Record<string, string> = {
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.sensitive === true ? { [GS_SENSITIVE_SESSION_HEADER]: GS_SENSITIVE_SESSION_HEADER_VALUE } : {}),
        }
        response = await this.options.fetch(path, {
          method: options.method ?? 'GET',
          signal: linked.signal,
          ...(Object.keys(headers).length === 0 ? {} : { headers }),
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        })
      } catch (cause) {
        if (linked.callerAborted()) throw (options.signal?.reason ?? cause) as Error
        if (linked.timedOut()) {
          throw new GsSkillRequestError(
            GS_SKILL_CLIENT_TIMEOUT_CODE, 0,
            `gsclaw-server skill request timed out after ${String(options.timeoutMs ?? 0)}ms`,
          )
        }
        throw cause
      }
      const text = await readLimitedText(response, options.maxBytes ?? MAX_GS_RESPONSE_BYTES)
      if (!response.ok) {
        let envelope: { code?: unknown; message?: unknown; traceId?: unknown } = {}
        try {
          const parsed: unknown = JSON.parse(text)
          if (typeof parsed === 'object' && parsed !== null) envelope = parsed
        } catch {
          // A non-JSON error page still maps to the http_<status> fallback below.
        }
        throw new GsSkillRequestError(
          typeof envelope.code === 'string' ? envelope.code : `http_${String(response.status)}`,
          response.status,
          typeof envelope.message === 'string'
            ? envelope.message
            : `gsclaw-server request failed with HTTP ${String(response.status)}`,
          typeof envelope.traceId === 'string' ? envelope.traceId : undefined,
        )
      }
      try {
        return JSON.parse(text) as T
      } catch {
        throw new GsSkillRequestError('bad_response', response.status, 'gsclaw-server returned a malformed response')
      }
    } finally {
      linked.release()
    }
  }

  /**
   * Server handshake metadata.
   * @param options - cancellation for this call.
   * @returns the parsed meta handshake.
   */
  meta(options: GsSkillCallOptions = {}): Promise<GsServerMeta> {
    return this.request<GsServerMeta>('/api/v1/meta', options)
  }

  /**
   * Full catalog including the server-executed runtime types.
   * @param options - cancellation for this call.
   * @returns the parsed catalog response.
   */
  catalog(options: GsSkillCallOptions = {}): Promise<GsSkillCatalogResponse> {
    return this.request<GsSkillCatalogResponse>('/api/v1/skills/catalog', options)
  }

  /**
   * Loadable definition of one server-executed skill.
   * @param skillName - exact skill name from the catalog.
   * @param options - cancellation for this call.
   * @returns the parsed definition response.
   */
  definition(skillName: string, options: GsSkillCallOptions = {}): Promise<GsSkillDefinitionResponse> {
    return this.request<GsSkillDefinitionResponse>(
      `/api/v1/skills/${encodeURIComponent(skillName)}/definition`,
      options,
    )
  }

  /**
   * File bundle of one client-runtime skill from `GET /api/skills/:name/files`.
   * The bundle JSON carries base64 content well past the shared 1 MiB gateway
   * cap, so this call reads with its own ceiling
   * ({@link MAX_SKILL_FILES_RESPONSE_BYTES}); the wire document is validated
   * field by field by {@link parseSkillFilesResponse}. Materialization safety
   * is the bundle cache's concern, not this method's.
   * @param skillName - exact skill name from the catalog.
   * @param options - cancellation and optional per-call timeout.
   * @returns the validated bundle descriptor.
   */
  async files(
    skillName: string,
    options: GsSkillCallOptions = {},
  ): Promise<{ readonly name: string; readonly files: readonly SkillBundleFile[] }> {
    const body = await this.request<unknown>(
      `/api/skills/${encodeURIComponent(skillName)}/files`,
      { ...options, maxBytes: MAX_SKILL_FILES_RESPONSE_BYTES },
    )
    return parseSkillFilesResponse(body)
  }

  /**
   * Execute one server-executed skill operation. Caller cancellation rethrows
   * the caller's abort reason; a client-side timeout and every server or
   * transport failure normalize into an `error` outcome — nothing is replayed.
   * A `sensitive` call carries the `x-gsclaw-sensitive: 1` audit header.
   * @param skillName - exact skill name from the catalog.
   * @param request - execute body carrying the echoed definition revision.
   * @param options - cancellation, optional per-call timeout, and the sensitive audit marker.
   * @returns the normalized outcome.
   */
  async execute(
    skillName: string,
    request: GsSkillExecuteRequest,
    options: GsSkillCallOptions = {},
  ): Promise<GsSkillExecuteOutcome> {
    const timeoutMs = options.timeoutMs ?? this.options.executeTimeoutMs
    let body: unknown
    try {
      body = await this.request<unknown>(
        `/api/v1/skills/${encodeURIComponent(skillName)}/execute`,
        {
          method: 'POST',
          body: request,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          timeoutMs,
          ...(options.sensitive === true ? { sensitive: true } : {}),
        },
      )
    } catch (cause) {
      if (options.signal?.aborted === true) throw (options.signal.reason ?? cause) as Error
      if (cause instanceof GsSkillRequestError) {
        return {
          status: 'error',
          code: cause.code,
          message: cause.message,
          ...(cause.traceId === undefined ? {} : { traceId: cause.traceId }),
        }
      }
      throw cause
    }
    return parseSkillExecuteResponse(body)
  }
}
