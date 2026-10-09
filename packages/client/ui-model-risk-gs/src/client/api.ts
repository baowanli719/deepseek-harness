/**
 * Same-origin calls to the Host's gs-server model-risk loopback routes. The
 * access token stays in the Host; the renderer only speaks to the loopback
 * paths. Server failures arrive as `{error, code?, retryAfter?}` and surface
 * here as {@link ModelRiskRequestError} with the server's message.
 */

import type {
  GsModelRiskDownloadRequest,
  GsModelRiskDownloadResponse,
  GsModelRiskSignRequest,
  GsModelRiskStatusRequest,
  GsModelRiskView,
} from './contract.ts'

// Loopback paths mirror GS_SERVER_MODEL_RISK_*_PATH in dsh-gs-server, relative
// for the renderer's same-origin fetch.
const STATUS_PATH = 'api/gs-server/model-risk/status'
const SIGN_PATH = 'api/gs-server/model-risk/sign'
const DOWNLOAD_PATH = 'api/gs-server/model-risk/download'

/** One failed model-risk request: HTTP status, optional machine code, server message. */
export class ModelRiskRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'ModelRiskRequestError'
  }
}

/**
 * Whether one failure reports that the protocol revision moved under an open
 * form: the signer must reload the current text and sign again.
 * @param error - failure raised by a sign call.
 * @returns true for the 409 revision-conflict signal.
 */
export function isRevisionConflict(error: unknown): boolean {
  return error instanceof ModelRiskRequestError
    && (error.status === 409 || error.code?.toLowerCase().includes('revision') === true)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function invalid(what: string): Error {
  return new Error(`invalid model-risk ${what} response`)
}

function mailStatus(value: unknown): GsModelRiskView['mailStatus'] {
  return value === 'sent' || value === 'failed' || value === 'pending' ? value : undefined
}

/** Validate one status wire body into the view. */
export function parseStatusView(value: unknown): GsModelRiskView {
  const row = record(value)
  if (row === undefined || typeof row.required !== 'boolean') throw invalid('status')
  if (row.required) {
    if (typeof row.revision !== 'string' || typeof row.title !== 'string' || typeof row.text !== 'string') {
      throw invalid('status')
    }
  }
  const view: GsModelRiskView = {
    required: row.required,
    revision: typeof row.revision === 'string' ? row.revision : '',
    title: typeof row.title === 'string' ? row.title : '',
    text: typeof row.text === 'string' ? row.text : '',
  }
  const consentId = row.consentId
  const status = mailStatus(row.mailStatus)
  return {
    ...view,
    ...(typeof consentId === 'string' && consentId !== '' ? { consentId } : {}),
    ...(status === undefined ? {} : { mailStatus: status }),
  }
}

/** Validate one download wire body. */
export function parseDownloadResponse(value: unknown): GsModelRiskDownloadResponse {
  const row = record(value)
  if (row === undefined || typeof row.pdfBase64 !== 'string') throw invalid('download')
  return { pdfBase64: row.pdfBase64 }
}

async function post<T>(path: string, body: unknown, parse: (value: unknown) => T): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    // No fabricated copy: a failure without a server envelope carries an empty
    // message, and the dialog shows its localized fallback instead.
    let fallback = ''
    let code: string | undefined
    try {
      const row = record(await response.json())
      if (typeof row?.error === 'string') fallback = row.error
      if (typeof row?.code === 'string') code = row.code
    } catch {
      // A non-JSON failure body keeps the empty message.
    }
    throw new ModelRiskRequestError(response.status, code, fallback)
  }
  return parse(await response.json())
}

/** Business face the dialog consumes; the slot inject face extends it. */
export interface ModelRiskApi {
  /** Read the current disclosure and this account's signing state for one route. */
  readonly readStatus: (request: GsModelRiskStatusRequest) => Promise<GsModelRiskView>
  /** Submit one signature; resolves with the fresh view. */
  readonly sign: (request: GsModelRiskSignRequest) => Promise<GsModelRiskView>
  /** Fetch the archived PDF for one consent. */
  readonly downloadPdf: (request: GsModelRiskDownloadRequest) => Promise<GsModelRiskDownloadResponse>
}

/**
 * Build the loopback-backed API.
 * @returns the fetch-bound call set.
 */
export function createModelRiskApi(): ModelRiskApi {
  return {
    readStatus: request => post(STATUS_PATH, request, parseStatusView),
    sign: request => post(SIGN_PATH, request, parseStatusView),
    downloadPdf: request => post(DOWNLOAD_PATH, request, parseDownloadResponse),
  }
}
