/**
 * REAL-composition coverage: a Host context boots webServer plus the gs-server
 * plugin against a scripted in-process gateway, and every assertion observes
 * the service contract, the emitted events, or the private HTTP routes.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { GsRequest } from '../src/client.ts'
import type { GsAuthUser, GsClientConfig } from '../src/contract.ts'
import { unavailableRefreshTokenProtector } from '../src/protector.ts'
import GsServer from '../src/index.ts'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const user: GsAuthUser = { id: 1, username: 'alice', displayName: 'Alice', role: 'user' }
const clientConfig: GsClientConfig = {
  version: 1,
  agent: { sandboxProfile: 'read-only', approvalPolicy: 'ask', dataClass: 'internal' },
  features: { customModel: false },
  settingsPages: {},
  permissions: { allowSubmit: true, allowExternalSkillInstall: false },
  skills: {},
  models: null,
  appUpdate: null,
  notice: null,
}

type Responder = (init: RequestInit) => Response | Promise<Response>

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function loginBody(accessToken = 'at-1', refreshToken = 'rt-1') {
  return { token: 'legacy', tokens: { accessToken, refreshToken, expiresIn: 3600 }, user, config: clientConfig }
}

function gateway(routes: Record<string, Responder>): { request: GsRequest; calls: { path: string; init: RequestInit }[] } {
  const calls: { path: string; init: RequestInit }[] = []
  const request: GsRequest = async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/gsworker/u, '')
    calls.push({ path, init })
    const responder = routes[path]
    if (responder === undefined) return json(404, { error: 'not_found', message: path })
    return responder(init)
  }
  return { request, calls }
}

/** Test protector: reversible "sealing" standing in for OS-backed storage. */
const protector = {
  available: () => true,
  protect: (plaintext: string) => Promise.resolve(Buffer.from(`sealed:${plaintext}`, 'utf8')),
  unprotect: (sealed: Uint8Array) => {
    const text = Buffer.from(sealed).toString('utf8')
    if (!text.startsWith('sealed:')) return Promise.reject(new Error('foreign blob'))
    return Promise.resolve(text.slice('sealed:'.length))
  },
}

interface BootOptions {
  readonly routes?: boolean
  readonly withWebServer?: boolean
  readonly gatewayRoutes?: Record<string, Responder>
  readonly protector?: typeof protector
}

async function boot(options: BootOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gs-server-'))
  dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  if (options.withWebServer !== false) {
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  }
  const { request, calls } = gateway(options.gatewayRoutes ?? {})
  const gsFiber = ctx.plugin(GsServer, {
    stateDir: dir,
    endpoint: 'http://127.0.0.1:8151/gsworker',
    clientVersion: '0.2.0-rc.2',
    routes: options.routes ?? true,
    protector: options.protector ?? protector,
    request,
  })
  await gsFiber
  const service = ctx.gsServer
  const origin = `http://127.0.0.1:${String(ctx.get('webServer')?.port ?? 0)}`
  return { ctx, dir, service, calls, origin, gsFiber }
}

async function api(origin: string, path: string, init: RequestInit = {}, originHeader: string | null = origin) {
  const headers = new Headers(init.headers)
  if (originHeader !== null) headers.set('origin', originHeader)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${origin}${path}`, { ...init, headers })
}

it('finishes startup after an authentication timeout and preserves the sealed credential for retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gs-server-'))
  dirs.push(dir)
  const credential = Buffer.from(`${(await protector.protect('saved-refresh')).toString('base64')}\n`)
  const credentialPath = join(dir, 'gs-refresh-token.bin')
  await writeFile(credentialPath, credential)
  const ctx = new Context()
  contexts.push(ctx)
  let aborted = false
  const request: GsRequest = (_url, init) => new Promise((_resolve, reject) => {
    const signal = init.signal!
    signal.addEventListener('abort', () => {
      aborted = true
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted', { cause: signal.reason }))
    }, { once: true })
  })
  await ctx.plugin(GsServer, {
    stateDir: dir, clientVersion: '0.2.0-rc.2', routes: false,
    endpoint: 'http://127.0.0.1:8151/gsworker', protector, request,
    restoreOnStart: true, authRequestTimeoutMs: 25,
  })
  expect(aborted).toBe(true)
  expect(ctx.gsServer.sessionView().status).toBe('signed-out')
  expect(await readFile(credentialPath)).toEqual(credential)
})

it('serves the signed-out session view only to same-origin loopback callers', async () => {
  const { service, origin } = await boot()
  expect(service.sessionView()).toMatchObject({ status: 'signed-out', endpoint: 'http://127.0.0.1:8151/gsworker' })
  await expect(service.getAccessToken()).resolves.toBeUndefined()
  expect(service.getClientConfig()).toBeUndefined()

  const ok = await api(origin, '/api/gs-server/session')
  expect(ok.status).toBe(200)
  expect(await ok.json()).toMatchObject({ status: 'signed-out' })
  expect(ok.headers.get('cache-control')).toBe('no-store')

  expect((await api(origin, '/api/gs-server/session', {}, null)).status).toBe(403)
  expect((await api(origin, '/api/gs-server/session', {}, 'http://evil.example')).status).toBe(403)
  expect((await api(origin, '/api/gs-server/session', { method: 'POST' })).status).toBe(405)
})

it('checks application updates through an authenticated config pull without exposing gateway credentials', async () => {
  const appUpdate = { version: '2.2.0', downloads: { windowsX64: 'http://lan.example/gs-worker.exe' } }
  const { origin, calls } = await boot({ gatewayRoutes: {
    '/api/auth/login': () => json(200, loginBody()),
    '/api/client-config': () => json(200, { user, config: { ...clientConfig, appUpdate } }),
  } })
  expect((await api(origin, '/api/gs-server/app-update', {}, 'http://evil.example')).status).toBe(403)
  expect((await api(origin, '/api/gs-server/app-update', { method: 'POST' })).status).toBe(405)
  expect((await api(origin, '/api/gs-server/app-update')).status).toBe(401)
  await api(origin, '/api/gs-server/login', { method: 'POST', body: JSON.stringify({ username: 'alice', password: 'pw' }) })
  const response = await api(origin, '/api/gs-server/app-update')
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ appUpdate })
  expect(response.headers.get('cache-control')).toBe('no-store')
  const pull = calls.find(call => call.path === '/api/client-config')
  expect(new Headers(pull?.init.headers).get('authorization')).toBe('Bearer at-1')
})

it('logs in through the private route and exposes the contract surface', async () => {
  const { service, origin, calls, ctx } = await boot({
    gatewayRoutes: {
      '/api/auth/login': () => json(200, loginBody()),
      '/api/probe': () => json(200, { ok: true }),
    },
  })
  const established: GsAuthUser[] = []
  const configs: GsClientConfig[] = []
  ctx.on('gs-server/session-established', (u) => { established.push(u) })
  ctx.on('gs-server/client-config-changed', (c) => { configs.push(c) })

  const denied = await api(origin, '/api/gs-server/login', { method: 'POST', body: JSON.stringify({ username: 'a' }) })
  expect(denied.status).toBe(400)

  const response = await api(origin, '/api/gs-server/login', {
    method: 'POST', body: JSON.stringify({ username: 'alice', password: 'pw' }),
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'signed-in', user: { username: 'alice' } })
  await expect(service.getAccessToken()).resolves.toBe('at-1')
  expect(service.getClientConfig()).toEqual(clientConfig)
  expect(established).toEqual([user])
  expect(configs).toEqual([clientConfig])

  const probe = await service.fetch('/api/probe')
  expect(probe.status).toBe(200)
  const probeCall = calls.find(call => call.path === '/api/probe')
  expect(new Headers(probeCall?.init.headers).get('authorization')).toBe('Bearer at-1')

  const session = await api(origin, '/api/gs-server/session')
  expect(await session.json()).toMatchObject({ status: 'signed-in', user: { displayName: 'Alice' } })
})

it('maps gateway login failures onto the stable renderer error shape', async () => {
  const { origin } = await boot({
    gatewayRoutes: {
      '/api/auth/login': () => json(401, { error: 'INVALID_CREDENTIALS', message: 'wrong password' }),
    },
  })
  const response = await api(origin, '/api/gs-server/login', {
    method: 'POST', body: JSON.stringify({ username: 'alice', password: 'bad' }),
  })
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ error: 'wrong password', code: 'INVALID_CREDENTIALS' })
})

it('answers 503 with safe_storage_unavailable when no protector backs the refresh token', async () => {
  const { origin } = await boot({
    protector: unavailableRefreshTokenProtector('linux') as typeof protector,
    gatewayRoutes: { '/api/auth/login': () => json(200, loginBody()) },
  })
  const response = await api(origin, '/api/gs-server/login', {
    method: 'POST', body: JSON.stringify({ username: 'alice', password: 'pw' }),
  })
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'safe_storage_unavailable' })
})

it('logout revokes best-effort, wipes the session, and never fires session-expired', async () => {
  const { ctx, service, origin, calls } = await boot({
    gatewayRoutes: {
      '/api/auth/login': () => json(200, loginBody()),
      '/api/v1/auth/logout': () => json(200, { ok: true }),
    },
  })
  const expired = vi.fn()
  ctx.on('gs-server/session-expired', expired)
  await service.loginWithPassword({ username: 'alice', password: 'pw' })
  const response = await api(origin, '/api/gs-server/logout', { method: 'POST', body: '{}' })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ accepted: true })
  expect(service.sessionView().status).toBe('signed-out')
  expect(service.getClientConfig()).toBeUndefined()
  expect(calls.map(call => call.path)).toContain('/api/v1/auth/logout')
  expect(expired).not.toHaveBeenCalled()

  const nonempty = await api(origin, '/api/gs-server/logout', { method: 'POST', body: '{"x":1}' })
  expect(nonempty.status).toBe(400)
})

it('refreshes once on an expired-token 401 and emits session-expired when the family is gone', async () => {
  let refreshFails = false
  const { ctx, service } = await boot({
    gatewayRoutes: {
      '/api/auth/login': () => json(200, loginBody()),
      '/api/data': () => json(401, { code: 'token_expired', message: 'expired' }),
      '/api/v1/auth/refresh': () => refreshFails
        ? json(401, { code: 'token_expired', message: 'family revoked' })
        : json(200, { tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 3600 }, user, config: clientConfig }),
    },
  })
  const expired = vi.fn()
  const revoked = vi.fn()
  ctx.on('gs-server/session-expired', expired)
  ctx.on('gs-server/trust-revoked', revoked)
  await service.loginWithPassword({ username: 'alice', password: 'pw' })

  refreshFails = true
  await expect(service.fetch('/api/data')).rejects.toMatchObject({ code: 'token_expired', status: 401 })
  expect(service.sessionView().status).toBe('signed-out')
  expect(expired).toHaveBeenCalledExactlyOnceWith()
  expect(revoked).not.toHaveBeenCalled()
})

it('emits trust-revoked when the server answers 403 to a refresh', async () => {
  const { ctx, service } = await boot({
    gatewayRoutes: {
      '/api/auth/login': () => json(200, loginBody()),
      '/api/v1/auth/refresh': () => json(403, { code: 'account_disabled', message: 'disabled' }),
    },
  })
  const revoked = vi.fn()
  ctx.on('gs-server/trust-revoked', revoked)
  await service.loginWithPassword({ username: 'alice', password: 'pw' })
  await expect(service.auth.refreshTokens()).rejects.toMatchObject({ status: 403 })
  expect(revoked).toHaveBeenCalledExactlyOnceWith()
})

it('restores a persisted session after a host restart', async () => {
  const first = await boot({
    gatewayRoutes: { '/api/auth/login': () => json(200, loginBody()) },
  })
  await first.service.loginWithPassword({ username: 'alice', password: 'pw' })
  const dir = first.dir

  const ctx = new Context()
  contexts.push(ctx)
  const { request } = gateway({
    '/api/v1/auth/refresh': () => json(200, { tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 3600 }, user, config: clientConfig }),
  })
  await ctx.plugin(GsServer, {
    stateDir: dir,
    endpoint: 'http://127.0.0.1:8151/gsworker',
    clientVersion: '0.2.0-rc.2',
    routes: false,
    protector,
    request,
  })
  await expect(ctx.gsServer.restoreSession()).resolves.toBe(true)
  await expect(ctx.gsServer.getAccessToken()).resolves.toBe('at-2')
  expect(ctx.gsServer.getClientConfig()).toEqual(clientConfig)
})

it('restores a persisted session during composition when the desktop startup gate requests it', async () => {
  const first = await boot({ gatewayRoutes: { '/api/auth/login': () => json(200, loginBody()) } })
  await first.service.loginWithPassword({ username: 'alice', password: 'pw' })
  const ctx = new Context()
  contexts.push(ctx)
  const { request } = gateway({
    '/api/v1/auth/refresh': () => json(200, {
      tokens: { accessToken: 'at-restored', refreshToken: 'rt-restored', expiresIn: 3600 }, user, config: clientConfig,
    }),
  })
  await ctx.plugin(GsServer, {
    stateDir: first.dir, endpoint: 'http://127.0.0.1:8151/gsworker', clientVersion: '0.2.0-rc.2',
    routes: false, restoreOnStart: true, protector, request,
  })
  expect(ctx.gsServer.sessionView().status).toBe('signed-in')
  await expect(ctx.gsServer.getAccessToken()).resolves.toBe('at-restored')
})

it('serves meta and brand, folding the handshake brand into the store', async () => {
  const { service, origin } = await boot({
    gatewayRoutes: {
      '/api/v1/meta': () => json(200, {
        serviceName: 'gsclaw-server', serviceVersion: '1.0.0', loginMethods: ['password'],
        minimumClientVersion: '0.1.0', llmProxy: true, brand: { name: '国盛证券', headline: '办公 Agent' },
      }),
    },
  })
  const meta = await api(origin, '/api/gs-server/meta')
  expect(meta.status).toBe(200)
  expect(await meta.json()).toMatchObject({ endpoint: 'http://127.0.0.1:8151/gsworker', meta: { serviceName: 'gsclaw-server' } })
  expect(service.brandView()).toEqual({ name: '国盛证券', headline: '办公 Agent' })
  const brand = await api(origin, '/api/gs-server/brand')
  expect(await brand.json()).toEqual({ name: '国盛证券', headline: '办公 Agent' })
})

it('fails loud when routes are enabled without a webServer, and boots with routes off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gs-server-'))
  dirs.push(dir)
  const broken = new Context()
  contexts.push(broken)
  await expect(async () => {
    await broken.plugin(GsServer, {
      stateDir: dir, endpoint: 'http://127.0.0.1:8151/gsworker', clientVersion: '0.2.0-rc.2',
      protector, request: gateway({}).request,
    })
  }).rejects.toThrow(/webServer/)

  const { ctx, service } = await boot({ withWebServer: false, routes: false })
  expect(ctx.get('webServer')).toBeUndefined()
  expect(service.sessionView().status).toBe('signed-out')
})

it('rejects a missing stateDir or clientVersion at load', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await expect(async () => {
    await ctx.plugin(GsServer, { clientVersion: '1' } as never)
  }).rejects.toThrow()
  await expect(async () => {
    await ctx.plugin(GsServer, { stateDir: 'x' } as never)
  }).rejects.toThrow()
})

it('removes the private routes when the plugin fiber disposes', async () => {
  const { origin, gsFiber } = await boot()
  expect((await api(origin, '/api/gs-server/session')).status).toBe(200)
  // The webServer survives; the routes are gone (its 404 fallback answers).
  await gsFiber.dispose()
  expect((await api(origin, '/api/gs-server/session')).status).toBe(404)
})
