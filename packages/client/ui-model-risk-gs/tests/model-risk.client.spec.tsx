// @vitest-environment jsdom
/**
 * Model-list lock decoration, consent before selection, disclosure dialog, signature
 * capture, revision conflicts, and the archived-PDF download. Props are fed
 * directly; the server is a stubbed global fetch behind the real loopback
 * call layer, so upload bodies are asserted at the wire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createModelRiskApi } from '../src/client/api.ts'
import { ModelRiskDialog } from '../src/client/ModelRisk.tsx'
import { ModelRiskBadge } from '../src/client/ModelRiskBadge.tsx'
import { ModelRiskController } from '../src/client/controller.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ModelSelect } from '../../ui-model-selection/src/client/ModelSelect.tsx'
import { zh as modelZh } from '../../ui-model-selection/src/client/locales.ts'
import type { ModelDirectoryState } from '../../ui-model-selection/src/client/directory.ts'
import { zh } from '../src/client/locale.ts'

const SID = SessionId('s1')

const VIEW = {
  required: true,
  revision: 'rev-1',
  title: '非可信云端模型风险揭示书',
  text: '第一条\n第二条',
}

const SIGNED = { ...VIEW, consentId: 'c-1', mailStatus: 'sent' }

interface ServerScript {
  readonly status?: Response | ((body: Record<string, unknown>) => Response | Promise<Response>)
  readonly sign?: Response | ((body: Record<string, unknown>) => Response | Promise<Response>)
  readonly download?: Response | ((body: Record<string, unknown>) => Response | Promise<Response>)
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function requestPath(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body
  return (typeof body === 'string' ? JSON.parse(body) : {}) as Record<string, unknown>
}

function stubServer(script: ServerScript) {
  const calls: { path: string; body: Record<string, unknown> }[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = requestPath(input)
    const body = requestBody(init)
    calls.push({ path, body })
    const route = path.endsWith('/status') ? script.status
      : path.endsWith('/sign') ? script.sign
        : path.endsWith('/download') ? script.download
          : undefined
    if (route === undefined) return Promise.resolve(json(404, { error: `unstubbed ${path}` }))
    return Promise.resolve(typeof route === 'function' ? route(body) : route.clone())
  }))
  return calls
}

const selection = { provider: 'gscloud', model: 'm1' }
function mount() {
  const onClose = vi.fn(), onSigned = vi.fn()
  render(<ModelRiskDialog selection={selection} {...createModelRiskApi()} t={makeTranslate(zh)} onClose={onClose} onSigned={onSigned} />)
  return { onClose, onSigned }
}
function signInk() {
  const canvas = screen.getByLabelText(zh.signatureAria)
  fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 20 })
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 30, clientY: 40 })
  fireEvent.pointerUp(canvas, { pointerId: 1 })
  fireEvent.click(screen.getByRole('checkbox'))
}

type CanvasStub = Pick<CanvasRenderingContext2D,
  'beginPath' | 'arc' | 'fill' | 'moveTo' | 'lineTo' | 'stroke' | 'clearRect'
  | 'lineWidth' | 'lineCap' | 'lineJoin' | 'strokeStyle' | 'fillStyle'>

let canvasContext: CanvasStub

const objectUrls = { create: vi.fn(() => 'blob:mock'), revoke: vi.fn(() => {}) }

function stubCanvas() {
  canvasContext = {
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    clearRect: vi.fn(),
    lineWidth: 3,
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '',
    fillStyle: '',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(canvasContext as CanvasRenderingContext2D)
}

beforeEach(() => {
  stubCanvas()
  // jsdom has no pointer capture and no object URLs; both are no-ops here.
  Object.assign(HTMLElement.prototype, { setPointerCapture: () => {} })
  Object.assign(URL, { createObjectURL: objectUrls.create, revokeObjectURL: objectUrls.revoke })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('requested model disclosure', () => {
  it('requests only acknowledgement and handwriting; signs the requested model without identity fields', async () => {
    const calls = stubServer({ status: json(200, VIEW), sign: json(200, SIGNED) })
    const { onSigned } = mount()
    await screen.findByRole('button', { name: zh.sign })
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText(zh.fullName)).toBeNull()
    expect(screen.queryByText(zh.email)).toBeNull()
    expect(onSigned).not.toHaveBeenCalled()
    signInk(); fireEvent.click(screen.getByRole('button', { name: zh.sign }))
    await screen.findByRole('button', { name: zh.downloadPdf })
    expect(onSigned).toHaveBeenCalledOnce()
    const { signature, ...request } = calls.find(c => c.path.endsWith('/sign'))?.body ?? {}
    expect(request).toEqual({
      providerId: 'gscloud', modelId: 'm1', revision: 'rev-1', acknowledged: true,
    })
    expect(Array.isArray(signature)).toBe(true)
  })
  it('keeps confirmation disabled until acknowledgement and never releases a failed signature', async () => {
    stubServer({ status: json(200, VIEW), sign: json(400, { error: '签署失败' }) })
    const { onSigned } = mount()
    const button = await screen.findByRole('button', { name: zh.sign })
    expect(button).toHaveProperty('disabled', true)
    signInk(); fireEvent.click(button)
    await screen.findByRole('alert')
    expect(onSigned).not.toHaveBeenCalled()
  })
  it('requires a server consent id before authorizing, even after an HTTP success', async () => {
    stubServer({ status: json(200, VIEW), sign: json(200, VIEW) })
    const { onSigned } = mount(); await screen.findByRole('button', { name: zh.sign })
    signInk(); fireEvent.click(screen.getByRole('button', { name: zh.sign }))
    await screen.findByRole('alert'); expect(onSigned).not.toHaveBeenCalled()
  })
  it('retries an unavailable protocol without releasing the selected model', async () => {
    let offline = true
    stubServer({ status: () => json(offline ? 503 : 200, offline ? { error: '服务异常' } : VIEW) })
    const { onSigned } = mount(); await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: zh.sign })).toBeNull()
    offline = false; fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    await screen.findByRole('button', { name: zh.sign }); expect(onSigned).not.toHaveBeenCalled()
  })
  it('closes cancellation without authorizing', async () => {
    stubServer({ status: json(200, VIEW) })
    const { onSigned, onClose } = mount(); await screen.findByRole('button', { name: zh.sign })
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(onClose).toHaveBeenCalledOnce(); expect(onSigned).not.toHaveBeenCalled()
  })
  it('reloads changed terms and clears acknowledgement after a revision conflict', async () => {
    let reads = 0
    stubServer({ status: () => json(200, ++reads === 1 ? VIEW : { ...VIEW, revision: 'rev-2', text: '新版协议' }), sign: json(409, { code: 'risk_revision_changed', error: 'changed' }) })
    const { onSigned } = mount(); await screen.findByRole('button', { name: zh.sign })
    signInk(); fireEvent.click(screen.getByRole('button', { name: zh.sign }))
    await screen.findByText('新版协议'); expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
    expect(onSigned).not.toHaveBeenCalled()
  })
  it('permits a model reclassified as trusted without signing', async () => {
    stubServer({ status: json(200, { required: false }) })
    const { onSigned, onClose } = mount()
    await waitFor(() => { expect(onSigned).toHaveBeenCalledOnce() }); expect(onClose).toHaveBeenCalledOnce()
  })
  it('downloads the archived PDF without requesting name or email', async () => {
    const calls = stubServer({ status: json(200, SIGNED), download: json(200, { pdfBase64: btoa('%PDF-fixture') }) })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    mount(); fireEvent.click(await screen.findByRole('button', { name: zh.downloadPdf }))
    await waitFor(() => { expect(click).toHaveBeenCalledOnce() })
    expect(calls.find(c => c.path.endsWith('/download'))?.body).toEqual({ consentId: 'c-1' })
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})

describe('model-row locks', () => {
  it.each([{ view: VIEW, title: zh.lockTitleUnsigned }, { view: SIGNED, title: zh.lockTitleSigned }])('decorates external rows with their signing state', async ({ view, title }) => {
    stubServer({ status: json(200, view) })
    render(<ModelRiskBadge selection={selection} {...createModelRiskApi()} t={makeTranslate(zh)} />)
    expect(await screen.findByRole('img', { name: title })).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('leaves trusted rows without a lock', async () => {
    const calls = stubServer({ status: json(200, { required: false }) })
    render(<ModelRiskBadge selection={selection} {...createModelRiskApi()} t={makeTranslate(zh)} />)
    await waitFor(() => { expect(calls).toHaveLength(1) }); await act(async () => {})
    expect(screen.queryByRole('img')).toBeNull()
  })
  it('retains a lock during status failures and recovers on focus', async () => {
    let offline = true
    stubServer({ status: () => json(offline ? 503 : 200, offline ? { error: 'offline' } : VIEW) })
    render(<ModelRiskBadge selection={selection} {...createModelRiskApi()} t={makeTranslate(zh)} />)
    await screen.findByRole('img', { name: zh.lockTitleUnavailable })
    offline = false; fireEvent(window, new Event('focus'))
    await screen.findByRole('img', { name: zh.lockTitleUnsigned })
  })
})

describe('selection authorization', () => {
  it('waits for a signed receipt and cancels without permitting selection', async () => {
    stubServer({ status: json(200, VIEW) }); const controller = new ModelRiskController(createModelRiskApi())
    const chosen = controller.authorize(SID, selection); const result = vi.fn(); void chosen.then(result)
    await waitFor(() => { expect(controller.requests.getSnapshot()?.selection).toEqual(selection) })
    expect(result).not.toHaveBeenCalled(); controller.close(); expect(await chosen).toBe(false)
    const next = controller.authorize(SID, selection)
    await waitFor(() => { expect(controller.requests.getSnapshot()).not.toBeNull() })
    controller.signed(); expect(await next).toBe(true)
  })
  it('permits trusted models directly and offers stored receipts for signed models', async () => {
    let signed = false
    stubServer({ status: () => json(200, signed ? SIGNED : { required: false }) })
    const controller = new ModelRiskController(createModelRiskApi())
    expect(await controller.authorize(SID, selection)).toBe(true); expect(controller.requests.getSnapshot()).toBeNull()
    signed = true; expect(await controller.authorize(SID, selection)).toBe(true)
    expect(controller.requests.getSnapshot()?.selection).toEqual(selection)
  })
  it('keeps a failed policy read pending for dialog retry', async () => {
    stubServer({ status: json(503, { error: 'offline' }) }); const controller = new ModelRiskController(createModelRiskApi())
    const chosen = controller.authorize(SID, selection)
    await waitFor(() => { expect(controller.requests.getSnapshot()).not.toBeNull() })
    controller.close(); expect(await chosen).toBe(false)
  })
  it('discards late policy responses after disposal', async () => {
    let resolve!: (value: typeof VIEW) => void
    const api = { ...createModelRiskApi(), readStatus: () => new Promise<typeof VIEW>((r) => { resolve = r }) }
    const controller = new ModelRiskController(api), chosen = controller.authorize(SID, selection)
    controller.close(); resolve(VIEW); expect(await chosen).toBe(false); expect(controller.requests.getSnapshot()).toBeNull()
  })
})

describe('model picker consent flow', () => {
  it('puts locks after model names and changes selection only after signing', async () => {
    Object.assign(Element.prototype, { scrollIntoView: () => {} })
    let signed = false
    const calls = stubServer({
      status: body => json(200, body.providerId === 'private' ? { required: false } : signed ? SIGNED : VIEW),
      sign: () => { signed = true; return json(200, SIGNED) },
    })
    const api = createModelRiskApi(), controller = new ModelRiskController(api)
    const directory = createSnapshotStore<ModelDirectoryState>({
      current: { provider: 'private', model: 'p' }, routable: true,
      groups: [{ id: 'private', name: 'private', models: [{ id: 'p', name: '私密模型' }] }, { id: 'gscloud', name: 'gscloud', models: [{ id: 'm1', name: '外部模型' }] }],
      failures: [], status: 'ready', pending: null, error: null,
    })
    render(<ModelSelect locked={false} available authorizeCurrentSelection directory={directory} load={() => {}}
      t={makeTranslate(modelZh)} renderSlot={(_, owner: object) =>
        <ModelRiskBadge selection={(owner as { selection: ModelSelection }).selection} {...api} t={makeTranslate(zh)} />}
      select={async (picked) => {
        if (!await controller.authorize(SID, picked)) return undefined
        directory.update((state) => { state.current = picked })
        return { ok: true, value: undefined }
      }} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    await screen.findByRole('img', { name: zh.lockTitleUnsigned })
    const rows = screen.getAllByRole('menuitemradio').map(row => ({ name: row.querySelector('span')?.textContent, lock: row.querySelector('[role=img]')?.getAttribute('aria-label') ?? null }))
    await expect(`${JSON.stringify(rows, null, 2)}\n`).toMatchFileSnapshot('./expected/model-risk-picker.json')
    fireEvent.click(screen.getByRole('menuitemradio', { name: /外部模型/ }))
    await waitFor(() => { expect(controller.requests.getSnapshot()?.selection).toEqual(selection) })
    expect(directory.getSnapshot().current?.provider).toBe('private')
    render(<ModelRiskDialog selection={selection} {...api} t={makeTranslate(zh)}
      onClose={() => { controller.close() }} onSigned={() => { controller.signed() }} />)
    await screen.findByRole('button', { name: zh.sign }); signInk(); fireEvent.click(screen.getByRole('button', { name: zh.sign }))
    await waitFor(() => { expect(directory.getSnapshot().current).toEqual(selection) })
    expect(calls.find(row => row.path.endsWith('/sign'))?.body).not.toHaveProperty('email')
    expect(calls.find(row => row.path.endsWith('/sign'))?.body).not.toHaveProperty('fullName')
    controller.close()
  })
})
