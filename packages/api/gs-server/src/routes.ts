/**
 * Strict loopback HTTP handlers for the private gs-server client API.
 *
 * A bundled renderer talks to these routes instead of holding gateway tokens
 * itself; credential state never leaves the Host process. Handlers are
 * registered on the Host `webServer` service through
 * {@link createGsServerRoutes}.
 *
 * @module
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { GsAuthStorageError } from './auth.ts'
import { GatewayError } from './client.ts'
import {
  GS_SERVER_BRAND_PATH,
  GS_SERVER_APP_UPDATE_PATH,
  GS_SERVER_CAPTCHA_PATH,
  GS_SERVER_EMAIL_CODE_PATH,
  GS_SERVER_EMAIL_LOGIN_PATH,
  GS_SERVER_LOGIN_PATH,
  GS_SERVER_LOGOUT_PATH,
  GS_SERVER_META_PATH,
  GS_SERVER_MODEL_RISK_DOWNLOAD_PATH,
  GS_SERVER_MODEL_RISK_SIGN_PATH,
  GS_SERVER_MODEL_RISK_STATUS_PATH,
  GS_SERVER_SESSION_PATH,
  type GsEmailCodeRequest,
  type GsEmailLoginRequest,
  type GsModelRiskDownloadRequest,
  type GsModelRiskSignRequest,
  type GsModelRiskStatusRequest,
  type GsModelRiskStroke,
  type GsPasswordLoginRequest,
  type GsServerErrorResponse,
} from './contract.ts'
import { isSameOriginLoopbackRequest } from './loopback.ts'
import type { GsServer } from './index.ts'

const MAX_GS_ROUTE_BODY_BYTES = 16 * 1024
const MAX_GS_SIGN_ROUTE_BODY_BYTES = 1024 * 1024

class BodyTooLargeError extends Error {}

function finishJson(
  res: ServerResponse,
  statusCode: number,
  value: object,
  allow?: 'GET' | 'POST',
): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  if (allow !== undefined) res.setHeader('allow', allow)
  res.end(JSON.stringify(value))
}

function error(
  message: string,
  detail: { readonly code?: string; readonly retryAfter?: number } = {},
): GsServerErrorResponse {
  return {
    error: message,
    ...(detail.code === undefined ? {} : { code: detail.code }),
    ...(detail.retryAfter === undefined ? {} : { retryAfter: detail.retryAfter }),
  }
}

/** Map gateway and storage failures onto the stable renderer error shape. */
function finishOperationFailure(res: ServerResponse, cause: unknown): void {
  if (cause instanceof GatewayError) {
    finishJson(res, cause.status === 0 ? 502 : cause.status, error(cause.message, {
      code: cause.code,
      ...(cause.retryAfter === undefined ? {} : { retryAfter: cause.retryAfter }),
    }))
    return
  }
  if (cause instanceof GsAuthStorageError) {
    finishJson(res, 503, error(cause.message, { code: 'safe_storage_unavailable' }))
    return
  }
  throw cause
}

function isJsonRequest(req: IncomingMessage): boolean {
  return req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const declaredLength = req.headers['content-length']
  if (declaredLength !== undefined) {
    if (!/^\d+$/u.test(declaredLength)) throw new SyntaxError('invalid content length')
    if (Number(declaredLength) > maxBytes) throw new BodyTooLargeError()
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > maxBytes) throw new BodyTooLargeError()
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed
}

const INVALID_BODY = Symbol('invalid body')

async function parsePostBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes = MAX_GS_ROUTE_BODY_BYTES,
): Promise<unknown> {
  if (!isJsonRequest(req)) {
    finishJson(res, 415, error('content type must be application/json'))
    return INVALID_BODY
  }
  try {
    return await readJson(req, maxBytes)
  } catch (cause) {
    const tooLarge = cause instanceof BodyTooLargeError
    finishJson(res, tooLarge ? 413 : 400, error(tooLarge ? 'request body is too large' : 'invalid JSON request'))
    return INVALID_BODY
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parsePasswordLoginRequest(value: unknown): GsPasswordLoginRequest | undefined {
  if (!isRecord(value) || typeof value.username !== 'string' || typeof value.password !== 'string') return undefined
  const captchaId = optionalString(value.captchaId)
  const captchaCode = optionalString(value.captchaCode)
  return {
    username: value.username,
    password: value.password,
    ...(captchaId === undefined ? {} : { captchaId }),
    ...(captchaCode === undefined ? {} : { captchaCode }),
  }
}

function parseEmailCodeRequest(value: unknown): GsEmailCodeRequest | undefined {
  if (!isRecord(value) || typeof value.account !== 'string') return undefined
  return { account: value.account }
}

function parseEmailLoginRequest(value: unknown): GsEmailLoginRequest | undefined {
  if (!isRecord(value) || typeof value.account !== 'string' || typeof value.code !== 'string') return undefined
  return { account: value.account, code: value.code }
}

function isEmptyRequest(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0
}

function parseModelRiskStatusRequest(value: unknown): GsModelRiskStatusRequest | undefined {
  if (!isRecord(value) || typeof value.providerId !== 'string' || typeof value.modelId !== 'string') return undefined
  return { providerId: value.providerId, modelId: value.modelId }
}

function isSignaturePoint(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'number' && typeof value[1] === 'number'
}

function parseModelRiskSignRequest(value: unknown): GsModelRiskSignRequest | undefined {
  if (!isRecord(value)
    || typeof value.providerId !== 'string' || typeof value.modelId !== 'string'
    || typeof value.revision !== 'string' || value.acknowledged !== true
    || !Array.isArray(value.signature)) return undefined
  const strokes: GsModelRiskStroke[] = []
  for (const stroke of value.signature as unknown[]) {
    if (!Array.isArray(stroke) || !stroke.every(isSignaturePoint)) return undefined
    strokes.push(stroke as GsModelRiskStroke)
  }
  return {
    providerId: value.providerId,
    modelId: value.modelId,
    revision: value.revision,
    acknowledged: true,
    signature: strokes,
  }
}

function parseModelRiskDownloadRequest(value: unknown): GsModelRiskDownloadRequest | undefined {
  if (!isRecord(value) || typeof value.consentId !== 'string') return undefined
  return { consentId: value.consentId }
}

/** Diagnostic sink for route failures that outlive their response. */
export type GsRouteReportError = (operation: string, cause: unknown) => void

function methodNotAllowed(res: ServerResponse, allow: 'GET' | 'POST'): void {
  finishJson(res, 405, error('method not allowed'), allow)
}

function forbidden(res: ServerResponse): void {
  finishJson(res, 403, error('forbidden'))
}

/**
 * Serve the configured endpoint plus the live server handshake.
 * @param req - the incoming request.
 * @param res - the response owned by this handler.
 * @param expectedOrigin - loopback origin the request must belong to.
 * @param service - Host-owned gs-server client.
 * @param reportError - diagnostic sink for failures that outlive the response.
 */
export async function handleGsServerMetaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
  reportError: GsRouteReportError = () => {},
): Promise<void> {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    forbidden(res)
    return
  }
  try {
    finishJson(res, 200, await service.getMeta())
  } catch (cause) {
    try {
      finishOperationFailure(res, cause)
    } catch (unexpected) {
      reportError('read gs-server meta', unexpected)
      finishJson(res, 500, error('gs-server metadata unavailable'))
    }
  }
}

/**
 * Serve the token-free session view.
 * @param req - the incoming request.
 * @param res - the response owned by this handler.
 * @param expectedOrigin - loopback origin the request must belong to.
 * @param service - Host-owned gs-server client.
 */
export function handleGsSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
): void {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    forbidden(res)
    return
  }
  finishJson(res, 200, service.sessionView())
}

/**
 * Serve the effective brand copy resolved by the Host brand store.
 * @param req - the incoming request.
 * @param res - the response owned by this handler.
 * @param expectedOrigin - loopback origin the request must belong to.
 * @param service - Host-owned gs-server client.
 */
export function handleGsBrandRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
): void {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    forbidden(res)
    return
  }
  finishJson(res, 200, service.brandView())
}

/**
 * Issue a fresh graphical captcha, or null on a legacy server.
 * @param req - the incoming request.
 * @param res - the response owned by this handler.
 * @param expectedOrigin - loopback origin the request must belong to.
 * @param service - Host-owned gs-server client.
 * @param reportError - diagnostic sink for failures that outlive the response.
 */
export async function handleGsCaptchaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
  reportError: GsRouteReportError = () => {},
): Promise<void> {
  if (req.method !== 'GET') {
    methodNotAllowed(res, 'GET')
    return
  }
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, false)) {
    forbidden(res)
    return
  }
  try {
    finishJson(res, 200, { captcha: await service.fetchCaptcha() })
  } catch (cause) {
    try {
      finishOperationFailure(res, cause)
    } catch (unexpected) {
      reportError('issue gs-server captcha', unexpected)
      finishJson(res, 500, error('gs-server captcha unavailable'))
    }
  }
}

/**
 * Password login through the Host-owned credential channel.
 * @param req - the incoming request.
 * @param res - the response owned by this handler.
 * @param expectedOrigin - loopback origin the request must belong to.
 * @param service - Host-owned gs-server client.
 * @param reportError - diagnostic sink for failures that outlive the response.
 */
export async function handleGsLoginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
  reportError: GsRouteReportError = () => {},
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST')
    return
  }
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    forbidden(res)
    return
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  const request = parsePasswordLoginRequest(value)
  if (request === undefined) {
    finishJson(res, 400, error('invalid login request'))
    return
  }
  try {
    finishJson(res, 200, await service.loginWithPassword(request))
  } catch (cause) {
    try {
      finishOperationFailure(res, cause)
    } catch (unexpected) {
      reportError('gs-server login', unexpected)
      finishJson(res, 500, error('gs-server login failed'))
    }
  }
}

/**
 * Send one email verification code for the submitted account.
 * @param req - the incoming request.
 * @param res - the response owned by this handler.
 * @param expectedOrigin - loopback origin the request must belong to.
 * @param service - Host-owned gs-server client.
 * @param reportError - diagnostic sink for failures that outlive the response.
 */
export async function handleGsEmailCodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
  reportError: GsRouteReportError = () => {},
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST')
    return
  }
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    forbidden(res)
    return
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  const request = parseEmailCodeRequest(value)
  if (request === undefined) {
    finishJson(res, 400, error('invalid email code request'))
    return
  }
  try {
    finishJson(res, 200, await service.sendEmailCode(request.account))
  } catch (cause) {
    try {
      finishOperationFailure(res, cause)
    } catch (unexpected) {
      reportError('send gs-server email code', unexpected)
      finishJson(res, 500, error('email code could not be sent'))
    }
  }
}

/**
 * Email-code login through the Host-owned credential channel.
 * @param req - the incoming request.
 * @param res - the response owned by this handler.
 * @param expectedOrigin - loopback origin the request must belong to.
 * @param service - Host-owned gs-server client.
 * @param reportError - diagnostic sink for failures that outlive the response.
 */
export async function handleGsEmailLoginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
  reportError: GsRouteReportError = () => {},
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST')
    return
  }
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    forbidden(res)
    return
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  const request = parseEmailLoginRequest(value)
  if (request === undefined) {
    finishJson(res, 400, error('invalid email login request'))
    return
  }
  try {
    finishJson(res, 200, await service.loginWithEmailCode(request))
  } catch (cause) {
    try {
      finishOperationFailure(res, cause)
    } catch (unexpected) {
      reportError('gs-server email login', unexpected)
      finishJson(res, 500, error('gs-server email login failed'))
    }
  }
}

/**
 * Revoke the session family and drop all local credential state.
 * @param req - the incoming request.
 * @param res - the response owned by this handler.
 * @param expectedOrigin - loopback origin the request must belong to.
 * @param service - Host-owned gs-server client.
 * @param reportError - diagnostic sink for failures that outlive the response.
 * @param onLoggedOut - fired after the logout answer succeeds.
 */
export async function handleGsLogoutRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
  reportError: GsRouteReportError = () => {},
  onLoggedOut: () => void = () => {},
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST')
    return
  }
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    forbidden(res)
    return
  }
  const value = await parsePostBody(req, res)
  if (value === INVALID_BODY) return
  if (!isEmptyRequest(value)) {
    finishJson(res, 400, error('invalid logout request'))
    return
  }
  try {
    await service.logout()
    finishJson(res, 200, { accepted: true })
    onLoggedOut()
  } catch (cause) {
    reportError('gs-server logout', cause)
    finishJson(res, 500, error('gs-server logout failed'))
  }
}

/** Wiring of one model-risk POST route: body cap, request parser, and service call. */
interface GsModelRiskOperation<TRequest> {
  readonly maxBodyBytes: number
  readonly invalidMessage: string
  readonly failureMessage: string
  readonly reportOperation: string
  readonly parse: (value: unknown) => TRequest | undefined
  readonly invoke: (service: GsServer, request: TRequest) => Promise<object>
}

async function handleGsModelRiskPost<TRequest>(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
  reportError: GsRouteReportError,
  operation: GsModelRiskOperation<TRequest>,
): Promise<void> {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST')
    return
  }
  if (!isSameOriginLoopbackRequest(req, expectedOrigin, true)) {
    forbidden(res)
    return
  }
  const value = await parsePostBody(req, res, operation.maxBodyBytes)
  if (value === INVALID_BODY) return
  const request = operation.parse(value)
  if (request === undefined) {
    finishJson(res, 400, error(operation.invalidMessage))
    return
  }
  try {
    finishJson(res, 200, await operation.invoke(service, request))
  } catch (cause) {
    try {
      finishOperationFailure(res, cause)
    } catch (unexpected) {
      reportError(operation.reportOperation, unexpected)
      finishJson(res, 500, error(operation.failureMessage))
    }
  }
}

/**
 * Query the model-risk disclosure status of one provider/model pair.
 * @param req - the incoming request.
 * @param res - the response owned by this handler.
 * @param expectedOrigin - loopback origin the request must belong to.
 * @param service - Host-owned gs-server client.
 * @param reportError - diagnostic sink for failures that outlive the response.
 */
export function handleGsModelRiskStatusRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
  reportError: GsRouteReportError = () => {},
): Promise<void> {
  return handleGsModelRiskPost(req, res, expectedOrigin, service, reportError, {
    maxBodyBytes: MAX_GS_ROUTE_BODY_BYTES,
    invalidMessage: 'invalid model risk status request',
    failureMessage: 'model risk status unavailable',
    reportOperation: 'gs-server model risk status',
    parse: parseModelRiskStatusRequest,
    invoke: (gs, request) => gs.modelRiskStatus(request),
  })
}

/**
 * Record one signed model-risk disclosure acknowledgment. The body carries
 * PII plus the signature strokes, so the route accepts up to
 * MAX_GS_SIGN_ROUTE_BODY_BYTES; the payload is forwarded verbatim and never
 * logged.
 * @param req - the incoming request.
 * @param res - the response owned by this handler.
 * @param expectedOrigin - loopback origin the request must belong to.
 * @param service - Host-owned gs-server client.
 * @param reportError - diagnostic sink for failures that outlive the response.
 */
export function handleGsModelRiskSignRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
  reportError: GsRouteReportError = () => {},
): Promise<void> {
  return handleGsModelRiskPost(req, res, expectedOrigin, service, reportError, {
    maxBodyBytes: MAX_GS_SIGN_ROUTE_BODY_BYTES,
    invalidMessage: 'invalid model risk sign request',
    failureMessage: 'model risk signing failed',
    reportOperation: 'gs-server model risk sign',
    parse: parseModelRiskSignRequest,
    invoke: (gs, request) => gs.modelRiskSign(request),
  })
}

/**
 * Download the signed disclosure PDF of one consent record.
 * @param req - the incoming request.
 * @param res - the response owned by this handler.
 * @param expectedOrigin - loopback origin the request must belong to.
 * @param service - Host-owned gs-server client.
 * @param reportError - diagnostic sink for failures that outlive the response.
 */
export function handleGsModelRiskDownloadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin: string,
  service: GsServer,
  reportError: GsRouteReportError = () => {},
): Promise<void> {
  return handleGsModelRiskPost(req, res, expectedOrigin, service, reportError, {
    maxBodyBytes: MAX_GS_ROUTE_BODY_BYTES,
    invalidMessage: 'invalid model risk download request',
    failureMessage: 'model risk download failed',
    reportOperation: 'gs-server model risk download',
    parse: parseModelRiskDownloadRequest,
    invoke: (gs, request) => gs.modelRiskDownload(request),
  })
}

/** Inputs for the `/api/gs-server/*` route table. */
export interface GsServerRoutesOptions {
  /** Host-owned gs-server client the handlers delegate to. */
  readonly service: GsServer
  /**
   * Expected loopback origin, resolved per request so an OS-assigned webServer
   * port is read only after listening.
   */
  readonly expectedOrigin: () => string
  /** Diagnostic sink for route failures that outlive their response. */
  readonly reportError?: GsRouteReportError
  /** Fired after a logout answer succeeds, e.g. to navigate back to login. */
  readonly onLoggedOut?: () => void
}

/**
 * Build the private route table for the Host webServer. Every entry is an
 * exact route; registration and disposal belong to the caller.
 * @param options - service face, origin resolver, and diagnostics.
 * @returns the exact routes to register on `ctx.webServer`.
 */
export function createGsServerRoutes(options: GsServerRoutesOptions): WebRoute[] {
  const reportError = options.reportError ?? (() => {})
  const onLoggedOut = options.onLoggedOut ?? (() => {})
  const service = options.service
  return [
    {
      kind: 'exact',
      path: GS_SERVER_APP_UPDATE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') { methodNotAllowed(res, 'GET'); return }
        if (!isSameOriginLoopbackRequest(req, options.expectedOrigin(), false)) { forbidden(res); return }
        try {
          const snapshot = await service.refreshClientConfig()
          finishJson(res, 200, { appUpdate: snapshot.config.appUpdate ?? null })
        } catch (cause) {
          try { finishOperationFailure(res, cause) }
          catch (unexpected) {
            reportError('check gs-server application update', unexpected)
            finishJson(res, 502, error('gs-server update check failed'))
          }
        }
      },
    },
    {
      kind: 'exact',
      path: GS_SERVER_META_PATH,
      handler: (req, res) => handleGsServerMetaRequest(req, res, options.expectedOrigin(), service, reportError),
    },
    {
      kind: 'exact',
      path: GS_SERVER_SESSION_PATH,
      handler: (req, res) => { handleGsSessionRequest(req, res, options.expectedOrigin(), service) },
    },
    {
      kind: 'exact',
      path: GS_SERVER_BRAND_PATH,
      handler: (req, res) => { handleGsBrandRequest(req, res, options.expectedOrigin(), service) },
    },
    {
      kind: 'exact',
      path: GS_SERVER_CAPTCHA_PATH,
      handler: (req, res) => handleGsCaptchaRequest(req, res, options.expectedOrigin(), service, reportError),
    },
    {
      kind: 'exact',
      path: GS_SERVER_LOGIN_PATH,
      handler: (req, res) => handleGsLoginRequest(req, res, options.expectedOrigin(), service, reportError),
    },
    {
      kind: 'exact',
      path: GS_SERVER_EMAIL_CODE_PATH,
      handler: (req, res) => handleGsEmailCodeRequest(req, res, options.expectedOrigin(), service, reportError),
    },
    {
      kind: 'exact',
      path: GS_SERVER_EMAIL_LOGIN_PATH,
      handler: (req, res) => handleGsEmailLoginRequest(req, res, options.expectedOrigin(), service, reportError),
    },
    {
      kind: 'exact',
      path: GS_SERVER_LOGOUT_PATH,
      handler: (req, res) => handleGsLogoutRequest(req, res, options.expectedOrigin(), service, reportError, onLoggedOut),
    },
    {
      kind: 'exact',
      path: GS_SERVER_MODEL_RISK_STATUS_PATH,
      handler: (req, res) => handleGsModelRiskStatusRequest(req, res, options.expectedOrigin(), service, reportError),
    },
    {
      kind: 'exact',
      path: GS_SERVER_MODEL_RISK_SIGN_PATH,
      handler: (req, res) => handleGsModelRiskSignRequest(req, res, options.expectedOrigin(), service, reportError),
    },
    {
      kind: 'exact',
      path: GS_SERVER_MODEL_RISK_DOWNLOAD_PATH,
      handler: (req, res) => handleGsModelRiskDownloadRequest(req, res, options.expectedOrigin(), service, reportError),
    },
  ]
}
