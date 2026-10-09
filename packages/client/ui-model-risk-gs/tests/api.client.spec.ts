/**
 * Loopback call layer: relative same-origin paths, JSON bodies, error-envelope
 * parsing, wire validation, and the revision-conflict signal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createModelRiskApi, isRevisionConflict, ModelRiskRequestError, parseDownloadResponse, parseStatusView,
} from '../src/client/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestPath(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function requestBody(init: RequestInit | undefined): unknown {
  const body = init?.body
  return typeof body === 'string' ? JSON.parse(body) as unknown : undefined
}

function stubFetch(handler: (path: string, body: unknown) => Response | Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(requestPath(input), requestBody(init))))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const VIEW = {
  required: true,
  revision: 'rev-1',
  title: '风险揭示书',
  text: '全文',
}

describe('createModelRiskApi', () => {
  it('posts the status request to the loopback status route', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, VIEW))
    const api = createModelRiskApi()
    const view = await api.readStatus({ providerId: 'gscloud', modelId: 'm1' })
    expect(view).toEqual({ required: true, revision: 'rev-1', title: '风险揭示书', text: '全文' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = fetchMock.mock.calls[0]!
    expect(path).toBe('api/gs-server/model-risk/status')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect(init?.redirect).toBe('error')
    expect(init?.cache).toBe('no-store')
    expect(requestBody(init)).toEqual({ providerId: 'gscloud', modelId: 'm1' })
  })

  it('posts the signature with revision, acknowledgement, and strokes', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { ...VIEW, consentId: 'c-1', mailStatus: 'pending' }))
    const api = createModelRiskApi()
    const view = await api.sign({
      providerId: 'gscloud',
      modelId: 'm1',
      revision: 'rev-1',
      acknowledged: true,
      signature: [[[0.1, 0.2], [0.3, 0.4]]],
    })
    expect(view.consentId).toBe('c-1')
    expect(view.mailStatus).toBe('pending')
    const [path, init] = fetchMock.mock.calls[0]!
    expect(path).toBe('api/gs-server/model-risk/sign')
    expect(requestBody(init)).toEqual({
      providerId: 'gscloud',
      modelId: 'm1',
      revision: 'rev-1',
      acknowledged: true,
      signature: [[[0.1, 0.2], [0.3, 0.4]]],
    })
  })

  it('posts the download request and returns the decoded envelope', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { pdfBase64: 'QUJD' }))
    const api = createModelRiskApi()
    await expect(api.downloadPdf({ consentId: 'c-1' })).resolves.toEqual({ pdfBase64: 'QUJD' })
    const [path, init] = fetchMock.mock.calls[0]!
    expect(path).toBe('api/gs-server/model-risk/download')
    expect(requestBody(init)).toEqual({ consentId: 'c-1' })
  })

  it('raises the server error envelope with message and code', async () => {
    stubFetch(() => jsonResponse(409, { error: '协议已更新', code: 'model_risk_revision_changed' }))
    const api = createModelRiskApi()
    const failure = await api.sign({
      providerId: 'gscloud', modelId: 'm1', revision: 'rev-0', acknowledged: true, signature: [],
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ModelRiskRequestError)
    const error = failure as ModelRiskRequestError
    expect(error.message).toBe('协议已更新')
    expect(error.status).toBe(409)
    expect(error.code).toBe('model_risk_revision_changed')
    expect(isRevisionConflict(error)).toBe(true)
  })

  it('treats a bare 409 as a revision conflict and other failures as plain errors', async () => {
    stubFetch(() => jsonResponse(409, { error: 'conflict' }))
    const api = createModelRiskApi()
    const conflict = await api.readStatus({ providerId: 'p', modelId: 'm' }).catch((error: unknown) => error)
    expect(isRevisionConflict(conflict)).toBe(true)

    vi.unstubAllGlobals()
    stubFetch(() => jsonResponse(500, { error: '服务异常' }))
    const failure = await api.readStatus({ providerId: 'p', modelId: 'm' }).catch((error: unknown) => error)
    expect(isRevisionConflict(failure)).toBe(false)
    expect((failure as ModelRiskRequestError).message).toBe('服务异常')
  })

  it('falls back to the status-derived message on a non-JSON failure body', async () => {
    stubFetch(() => Promise.resolve(new Response('oops', { status: 502 })))
    const api = createModelRiskApi()
    const failure = await api.readStatus({ providerId: 'p', modelId: 'm' }).catch((error: unknown) => error)
    expect((failure as ModelRiskRequestError).message).toBe('')
  })

  it('keeps the empty message when the failure envelope carries no error text', async () => {
    stubFetch(() => jsonResponse(503, { code: 'maintenance' }))
    const api = createModelRiskApi()
    const failure = await api.readStatus({ providerId: 'p', modelId: 'm' }).catch((error: unknown) => error)
    const requestError = failure as ModelRiskRequestError
    expect(requestError.message).toBe('')
    expect(requestError.code).toBe('maintenance')
  })
})

describe('wire validation', () => {
  it('accepts a not-required status without text fields', () => {
    expect(parseStatusView({ required: false })).toEqual({ required: false, revision: '', title: '', text: '' })
  })

  it('drops unknown mail statuses and empty consent ids', () => {
    expect(parseStatusView({ ...VIEW, consentId: '', mailStatus: 'queued' })).toEqual(VIEW)
  })

  it('rejects malformed status and download bodies', () => {
    expect(() => parseStatusView(null)).toThrow('invalid model-risk status response')
    expect(() => parseStatusView({ required: true, revision: 1 })).toThrow('invalid model-risk status response')
    expect(() => parseStatusView({ required: 'yes' })).toThrow('invalid model-risk status response')
    expect(() => parseDownloadResponse({})).toThrow('invalid model-risk download response')
    expect(() => parseDownloadResponse([])).toThrow('invalid model-risk download response')
  })
})
