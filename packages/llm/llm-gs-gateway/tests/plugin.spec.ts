/** Real-composition mount: proxy lifecycle, service publication, and settings mirroring. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { GsClientConfig, GsModelsConfig } from '@deepseek-ai/dsh-gs-server'
import * as Gateway from '@deepseek-ai/dsh-llm-gs-gateway'

const REAL_TOKEN = 'real-access-token'

interface SettingsCall {
  ns: string
  section?: unknown
  ops?: unknown
}

interface Harness {
  ctx: Context
  upstreamRequests: Array<{ url: string | undefined; authorization: string | undefined; sensitive: string | undefined; body: string }>
  settings: { replaced: SettingsCall[]; mutated: SettingsCall[] }
  setAccessToken(token: string | undefined): void
  setClientConfig(config: GsClientConfig | undefined): void
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** A complete ClientConfig carrying the supplied models section. */
function clientConfig(models: GsModelsConfig | null): GsClientConfig {
  return {
    version: 1,
    agent: { sandboxProfile: 'workspace-write', approvalPolicy: 'ask', dataClass: 'internal' },
    features: { customModel: false },
    settingsPages: {},
    permissions: { allowSubmit: true, allowExternalSkillInstall: false },
    skills: {},
    models,
    appUpdate: null,
    notice: null,
  }
}

const CLIENT_CONFIG: GsClientConfig = clientConfig({
  providers: {
    'gs-cloud': {
      api: 'openai-completions',
      models: [{ id: 'qwen-max', name: 'Qwen Max' }],
    },
  },
  defaultPrimary: 'gs-cloud/qwen-max',
})

/** Boot a root context with stub gsServer/settings services and a real mock upstream. */
async function boot(options: {
  accessToken?: string | undefined
  clientConfig?: GsClientConfig | undefined
  launchToken?: string
  config?: object
} = {}): Promise<Harness> {
  const upstreamRequests: Harness['upstreamRequests'] = []
  const upstream: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      upstreamRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
        sensitive: req.headers['x-gsclaw-sensitive'] as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', () => { upstream.off('error', reject); resolve() })
  })
  cleanups.push(() => new Promise<void>((resolve) => {
    upstream.close(() => { resolve() })
    upstream.closeIdleConnections()
  }))
  const upstreamPort = (upstream.address() as AddressInfo).port

  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  let accessToken = 'accessToken' in options ? options.accessToken : REAL_TOKEN
  let clientConfig = 'clientConfig' in options ? options.clientConfig : CLIENT_CONFIG
  const gsServer = {
    getAccessToken: () => Promise.resolve(accessToken),
    fetch: (path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (accessToken !== undefined) headers.set('authorization', `Bearer ${accessToken}`)
      return fetch(`http://127.0.0.1:${String(upstreamPort)}${path}`, { ...init, headers })
    },
    getClientConfig: () => clientConfig,
  }
  ctx.provide('gsServer', gsServer as never)
  const settings = { replaced: [] as SettingsCall[], mutated: [] as SettingsCall[] }
  ctx.provide('settings', {
    replace: (ns: string, section: object) => {
      settings.replaced.push({ ns, section: structuredClone(section) })
      return Promise.resolve()
    },
    mutate: (ns: string, ops: readonly unknown[]) => {
      settings.mutated.push({ ns, ops: structuredClone(ops) })
      return Promise.resolve()
    },
  } as never)
  if (options.launchToken !== undefined) {
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([
      { source: 'process', values: { [Gateway.GS_LLM_GATEWAY_CREDENTIAL_REF]: options.launchToken } },
    ]))
  }
  const fiber = ctx.plugin(Gateway, options.config ?? {})
  await fiber.await()
  return {
    ctx,
    upstreamRequests,
    settings,
    setAccessToken(token) { accessToken = token },
    setClientConfig(config) { clientConfig = config },
  }
}

describe('llm-gs-gateway plugin', () => {
  it('starts the proxy, publishes gsLlmGateway, and mirrors the cached ClientConfig at mount', async () => {
    const harness = await boot()

    expect(harness.ctx.gsLlmGateway.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(harness.settings.replaced).toHaveLength(1)
    expect(harness.settings.replaced[0]).toEqual({
      ns: 'llm-pi-ai',
      section: {
        providers: {
          'gs-cloud': {
            displayName: 'gs-cloud',
            api: 'openai-completions',
            baseURL: `${harness.ctx.gsLlmGateway.origin}/v1/gs-cloud`,
            apiKeyEnv: Gateway.GS_LLM_GATEWAY_CREDENTIAL_REF,
            compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' },
            models: [{ id: 'qwen-max', name: 'Qwen Max' }],
          },
        },
      },
    })
    expect(harness.settings.mutated).toEqual([{
      ns: 'agent-default-model',
      ops: [
        { op: 'set', path: ['provider'], value: 'gs-cloud' },
        { op: 'set', path: ['model'], value: 'qwen-max' },
      ],
    }])
  })

  it('serves model requests through the mounted proxy with the real access token', async () => {
    const harness = await boot()

    const response = await fetch(harness.ctx.gsLlmGateway.providerBaseUrl('gs-cloud') + '/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${harness.ctx.gsLlmGateway.token}` },
      body: '{"model":"qwen-max"}',
    })

    expect(response.status).toBe(200)
    expect(harness.upstreamRequests).toEqual([{
      url: '/api/v1/llm/gs-cloud/v1/chat/completions',
      authorization: `Bearer ${REAL_TOKEN}`,
      sensitive: undefined,
      body: '{"model":"qwen-max"}',
    }])
  })

  it('emits the sensitive audit header for sessions the sensitivePolicy service judges private', async () => {
    const harness = await boot()
    harness.ctx.provide('sensitivePolicy', { isPrivate: (id: string) => id === 's-private' } as never)

    const post = (sessionId: string) => fetch(harness.ctx.gsLlmGateway.providerBaseUrl('gs-cloud') + '/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${harness.ctx.gsLlmGateway.token}`, 'x-session-id': sessionId },
      body: '{"model":"qwen-max"}',
    })
    await post('s-private')
    await post('s-standard')

    expect(harness.upstreamRequests.map(request => request.sensitive)).toEqual(['1', undefined])
  })

  it('re-mirrors on client-config-changed and skips identical pushes', async () => {
    const harness = await boot()
    expect(harness.settings.replaced).toHaveLength(1)

    harness.ctx.emit('gs-server/client-config-changed', CLIENT_CONFIG)
    await vi.waitFor(() => { expect(harness.settings.mutated).toHaveLength(1) })
    expect(harness.settings.replaced).toHaveLength(1)

    const next = clientConfig({
      providers: {
        'gs-cloud': { api: 'openai-completions', models: [{ id: 'qwen-max' }, { id: 'qwen-lite' }] },
      },
      defaultPrimary: 'gs-cloud/qwen-lite',
    })
    harness.ctx.emit('gs-server/client-config-changed', next)
    await vi.waitFor(() => { expect(harness.settings.replaced).toHaveLength(2) })
    expect(harness.settings.replaced[1]?.section).toMatchObject({
      providers: { 'gs-cloud': { models: [{ id: 'qwen-max' }, { id: 'qwen-lite' }] } },
    })
    expect(harness.settings.mutated[1]?.ops).toEqual([
      { op: 'set', path: ['provider'], value: 'gs-cloud' },
      { op: 'set', path: ['model'], value: 'qwen-lite' },
    ])
  })

  it('mirrors on session-established when the mount predates the session', async () => {
    const harness = await boot({ clientConfig: undefined })
    expect(harness.settings.replaced).toHaveLength(0)

    harness.setClientConfig(CLIENT_CONFIG)
    harness.ctx.emit('gs-server/session-established', { id: 1, username: 'alice', displayName: 'Alice', role: 'user' })

    await vi.waitFor(() => { expect(harness.settings.replaced).toHaveLength(1) })
    expect(harness.settings.mutated).toHaveLength(1)
  })

  it('adopts a composition-supplied launch-environment token', async () => {
    const launchToken = Gateway.createGsLlmGatewayToken()
    const harness = await boot({ launchToken })

    expect(harness.ctx.gsLlmGateway.token).toBe(launchToken)
    const response = await fetch(harness.ctx.gsLlmGateway.providerBaseUrl('gs-cloud') + '/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${launchToken}` },
      body: '{}',
    })
    expect(response.status).toBe(200)
  })

  it('fails the mount loudly when a mirrored namespace does not exist', async () => {
    const ctx = new Context()
    cleanups.push(async () => { await ctx.fiber.dispose() })
    ctx.provide('gsServer', {
      getAccessToken: () => Promise.resolve(REAL_TOKEN),
      fetch: () => Promise.reject(new Error('unreachable')),
      getClientConfig: () => CLIENT_CONFIG,
    } as never)
    ctx.provide('settings', {
      replace: () => Promise.reject(new Error('No configurable plugin entry "llm-pi-ai"')),
      mutate: () => Promise.resolve(),
    } as never)

    const fiber = ctx.plugin(Gateway, {})
    await expect(fiber.await()).rejects.toThrow('llm-pi-ai')
  })

  it('closes the proxy port and withdraws the service on disposal', async () => {
    const harness = await boot()
    const origin = harness.ctx.gsLlmGateway.origin
    const token = harness.ctx.gsLlmGateway.token

    await harness.ctx.fiber.dispose()

    await expect(fetch(`${origin}/v1/gs-cloud/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: '{}',
    })).rejects.toThrow()
    expect(harness.ctx.get('gsLlmGateway')).toBeUndefined()
  })
})
