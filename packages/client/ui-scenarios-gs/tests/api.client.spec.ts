/** Loopback transport and strict scenario-shortcuts response validation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createScenarioShortcutsApi, parseScenarioShortcutsResponse, ScenarioShortcutsRequestError,
} from '../src/client/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function stubFetch(handler: () => Response | Promise<Response>) {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    void init
    return Promise.resolve(handler())
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const CUSTOM = {
  enabled: true,
  items: [
    { id: 'custom', label: '自定义场景', skill: 'custom-skill' },
    { id: 'hidden', label: '隐藏场景', skill: 'hidden-skill', enabled: false },
  ],
}

describe('createScenarioShortcutsApi', () => {
  it('gets and validates the loopback scenario configuration', async () => {
    const fetchMock = stubFetch(() => jsonResponse(200, { scenarioShortcuts: CUSTOM }))
    const api = createScenarioShortcutsApi()
    await expect(api.fetchScenarioShortcuts(new AbortController().signal)).resolves.toEqual(CUSTOM)
    const [path, init] = fetchMock.mock.calls[0]!
    expect(path).toBe('api/gs-server/scenario-shortcuts')
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.body).toBeUndefined()
  })

  it('preserves undefined and null as distinct server settings', async () => {
    stubFetch(() => jsonResponse(200, {}))
    await expect(createScenarioShortcutsApi().fetchScenarioShortcuts(new AbortController().signal)).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(200, { scenarioShortcuts: null }))))
    await expect(createScenarioShortcutsApi().fetchScenarioShortcuts(new AbortController().signal)).resolves.toBeNull()
  })

  it('raises the server error envelope with status and message', async () => {
    stubFetch(() => jsonResponse(503, { error: '服务异常' }))
    const failure = await createScenarioShortcutsApi().fetchScenarioShortcuts(new AbortController().signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ScenarioShortcutsRequestError)
    expect(failure).toMatchObject({ status: 503, message: '服务异常' })
  })

  it('keeps an empty message for non-JSON and message-less failures', async () => {
    stubFetch(() => new Response('oops', { status: 502 }))
    const nonJson = await createScenarioShortcutsApi().fetchScenarioShortcuts(new AbortController().signal).catch((error: unknown) => error)
    expect(nonJson).toMatchObject({ status: 502, message: '' })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse(500, { code: 'maintenance' }))))
    const messageLess = await createScenarioShortcutsApi().fetchScenarioShortcuts(new AbortController().signal)
      .catch((error: unknown) => error)
    expect(messageLess).toMatchObject({ status: 500, message: '' })
  })

  it('surfaces invalid success JSON as a validation failure', async () => {
    stubFetch(() => jsonResponse(200, { scenarioShortcuts: { enabled: true, items: [{ id: 'x' }] } }))
    await expect(createScenarioShortcutsApi().fetchScenarioShortcuts(new AbortController().signal)).rejects.toThrow('invalid scenario shortcuts response')
  })
})

describe('parseScenarioShortcutsResponse', () => {
  it('accepts defaults, hidden, globally disabled, empty, and per-item disabled settings', () => {
    expect(parseScenarioShortcutsResponse({})).toBeUndefined()
    expect(parseScenarioShortcutsResponse({ scenarioShortcuts: null })).toBeNull()
    expect(parseScenarioShortcutsResponse({ scenarioShortcuts: { enabled: false, items: [] } }))
      .toEqual({ enabled: false, items: [] })
    expect(parseScenarioShortcutsResponse({ scenarioShortcuts: CUSTOM })).toEqual(CUSTOM)
  })

  it.each([
    null,
    [],
    'config',
    { scenarioShortcuts: 1 },
    { scenarioShortcuts: { enabled: 'yes', items: [] } },
    { scenarioShortcuts: { enabled: true } },
    { scenarioShortcuts: { enabled: true, items: {} } },
  ])('rejects a malformed envelope or global config: %j', (value) => {
    expect(() => parseScenarioShortcutsResponse(value)).toThrow('invalid scenario shortcuts response')
  })

  it.each([
    null,
    {},
    { id: 1, label: 'x', skill: 'x' },
    { id: '', label: 'x', skill: 'x' },
    { id: ' \t\n', label: 'x', skill: 'x' },
    { id: 'x', label: 1, skill: 'x' },
    { id: 'x', label: '', skill: 'x' },
    { id: 'x', label: ' \t\n', skill: 'x' },
    { id: 'x', label: 'x', skill: 1 },
    { id: 'x', label: 'x', skill: '' },
    { id: 'x', label: 'x', skill: ' ' },
    { id: 'x', label: 'x', skill: '/skill' },
    { id: 'x', label: 'x', skill: 'skill/name' },
    { id: 'x', label: 'x', skill: 'Skill' },
    { id: 'x', label: 'x', skill: 'my_skill' },
    { id: 'x', label: 'x', skill: 'skill\n' },
    { id: 'x', label: 'x', skill: '-skill' },
    { id: 'x', label: 'x', skill: 'skill-' },
    { id: 'x', label: 'x', skill: 'skill--name' },
    { id: 'x', label: 'x', skill: 'x', enabled: 'no' },
  ])('rejects a malformed item: %j', (item) => {
    expect(() => parseScenarioShortcutsResponse({ scenarioShortcuts: { enabled: true, items: [item] } }))
      .toThrow('invalid scenario shortcuts response')
  })

  it('rejects duplicate item identities', () => {
    const item = { id: 'same', label: 'x', skill: 'x' }
    expect(() => parseScenarioShortcutsResponse({ scenarioShortcuts: { enabled: true, items: [item, item] } }))
      .toThrow('invalid scenario shortcuts response')
  })
})
