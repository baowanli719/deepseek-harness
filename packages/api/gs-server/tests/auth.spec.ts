/** Authentication state machine: sealing, single-flight rotation, restore, loss. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  emailCodeWindowSeconds,
  GsAuthService,
  GsAuthStorageError,
  gsRefreshTokenPath,
  type GsAuthOptions,
} from '../src/auth.ts'
import type { GsRequest } from '../src/client.ts'
import type { GsAuthUser, GsClientConfig } from '../src/contract.ts'
import { unavailableRefreshTokenProtector, type GsRefreshTokenProtector } from '../src/protector.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

it('discards a late refresh after logout without recreating credentials', async () => {
  const response = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<undefined>()
  const onSessionEstablished = vi.fn()
  const { auth, dir } = await fixture({
    '/api/auth/login': () => json(200, loginResponse()),
    '/api/v1/auth/refresh': () => { started.resolve(undefined); return response.promise },
    '/api/v1/auth/logout': () => new Response(null, { status: 204 }),
  }, { onSessionEstablished })
  await auth.loginWithPassword({ username: 'alice', password: 'fixture-only' })
  const refresh = auth.refreshTokens()
  const rejected = expect(refresh).rejects.toThrow(/superseded/)
  await started.promise
  await auth.logout()
  response.resolve(json(200, loginResponse('at-late', 'rt-late')))
  await rejected
  expect(auth.snapshot().status).toBe('signed-out')
  await expect(readFile(gsRefreshTokenPath(dir))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(onSessionEstablished).toHaveBeenCalledTimes(1)
})

it('does not let a rejected old refresh clear a newly logged-in account', async () => {
  const response = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<undefined>()
  const { auth } = await fixture({
    '/api/auth/login': () => json(200, loginResponse('at-new', 'rt-new')),
    '/api/v1/auth/refresh': () => { started.resolve(undefined); return response.promise },
  })
  await auth.loginWithPassword({ username: 'alice', password: 'fixture-only' })
  const refresh = auth.refreshTokens()
  const rejected = expect(refresh).rejects.toMatchObject({ status: 401 })
  await started.promise
  await auth.adoptTokens({ accessToken: 'at-bob', refreshToken: 'rt-bob', expiresIn: 3600 },
    { ...user, id: 2, username: 'bob' }, clientConfig)
  response.resolve(json(401, { error: 'expired', message: 'old refresh' }))
  await rejected
  expect(auth.snapshot().user?.username).toBe('bob')
  expect(auth.accessToken()).toBe('at-bob')
})

it('keeps logout authoritative while an OS credential seal is still pending', async () => {
  const gate = Promise.withResolvers<Uint8Array>()
  const entered = Promise.withResolvers<undefined>()
  const protector = testProtector()
  let count = 0
  const original = testProtector()
  const protect = (plaintext: string) => original.protect(plaintext)
  protector.protect = (plaintext) => {
    if (++count === 1) return protect(plaintext)
    entered.resolve(undefined)
    return gate.promise
  }
  const { auth, dir } = await fixture({
    '/api/auth/login': () => json(200, loginResponse()),
    '/api/v1/auth/refresh': () => json(200, loginResponse('at-late', 'rt-late')),
    '/api/v1/auth/logout': () => new Response(null, { status: 204 }),
  }, { protector })
  await auth.loginWithPassword({ username: 'alice', password: 'fixture-only' })
  const refreshing = auth.refreshTokens()
  const refused = expect(refreshing).rejects.toThrow('superseded')
  onTestFinished(async () => { gate.resolve(Buffer.from('sealed:rt-late')); await refused })
  await entered.promise
  const logout = auth.logout()
  expect(auth.snapshot().status).toBe('signed-out')
  gate.resolve(Buffer.from('sealed:rt-late'))
  await Promise.all([logout, refused])
  await expect(readFile(gsRefreshTokenPath(dir))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(auth.accessToken()).toBeUndefined()
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

function loginResponse(accessToken = 'at-1', refreshToken = 'rt-1') {
  return { token: 'legacy-token', tokens: { accessToken, refreshToken, expiresIn: 3600 }, user, config: clientConfig }
}

/** Test protector: base64-reversible "sealing" that rejects foreign blobs. */
function testProtector(): GsRefreshTokenProtector {
  return {
    available: () => true,
    protect: plaintext => Promise.resolve(Buffer.from(`sealed:${plaintext}`, 'utf8')),
    unprotect: (sealed) => {
      const text = Buffer.from(sealed).toString('utf8')
      if (!text.startsWith('sealed:')) return Promise.reject(new Error('foreign blob'))
      return Promise.resolve(text.slice('sealed:'.length))
    },
  }
}

type Responder = (init: RequestInit) => Response | Promise<Response>

interface GatewayCapture {
  readonly request: GsRequest
  readonly calls: { path: string; init: RequestInit }[]
}

function gateway(routes: Record<string, Responder>): GatewayCapture {
  const calls: { path: string; init: RequestInit }[] = []
  const request: GsRequest = async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/gsworker/u, '')
    calls.push({ path, init })
    const responder = routes[path]
    if (responder === undefined) return new Response(JSON.stringify({ error: 'not_found', message: path }), { status: 404 })
    return responder(init)
  }
  return { request, calls }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Parse the JSON body of one captured gateway call. */
function bodyJson(init: RequestInit): Record<string, unknown> {
  return JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>
}

async function fixture(
  routes: Record<string, Responder>,
  options: Partial<GsAuthOptions> = {},
): Promise<{ auth: GsAuthService; dir: string; calls: { path: string; init: RequestInit }[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gs-auth-'))
  dirs.push(dir)
  const { request, calls } = gateway(routes)
  const auth = new GsAuthService({
    endpoint: () => 'http://127.0.0.1:8151/gsworker',
    stateDir: dir,
    protector: testProtector(),
    client: { platform: 'windows', version: '0.2.0-rc.2' },
    request,
    ...options,
  })
  return { auth, dir, calls }
}

it('password login seals and persists the refresh token and fires the session callbacks', async () => {
  const onConfig = vi.fn()
  const onSessionEstablished = vi.fn()
  const { auth, dir, calls } = await fixture({ '/api/auth/login': () => json(200, loginResponse()) }, {
    onConfig, onSessionEstablished,
  })
  const snapshot = await auth.loginWithPassword({ username: 'alice', password: 'pw' })
  expect(snapshot).toEqual({ status: 'signed-in', user })
  expect(auth.accessToken()).toBe('at-1')
  const persisted = await readFile(gsRefreshTokenPath(dir), 'utf8')
  expect(Buffer.from(persisted.trim(), 'base64').toString('utf8')).toBe('sealed:rt-1')
  expect(onConfig).toHaveBeenCalledExactlyOnceWith(user, clientConfig)
  expect(onSessionEstablished).toHaveBeenCalledExactlyOnceWith(user)
  const body = bodyJson(calls[0]?.init ?? {})
  expect(body).toMatchObject({ username: 'alice', password: 'pw', client: { platform: 'windows', version: '0.2.0-rc.2' } })
})

it('refuses login when no OS-backed protector is available and writes nothing', async () => {
  const { auth, dir } = await fixture(
    { '/api/auth/login': () => json(200, loginResponse()) },
    { protector: unavailableRefreshTokenProtector('linux') },
  )
  await expect(auth.loginWithPassword({ username: 'alice', password: 'pw' })).rejects.toBeInstanceOf(GsAuthStorageError)
  expect(auth.snapshot()).toEqual({ status: 'signed-out' })
  await expect(readFile(gsRefreshTokenPath(dir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps a legacy memory-only session when the server issues no rotating tokens', async () => {
  const { auth, dir } = await fixture({
    '/api/auth/login': () => json(200, { token: 'legacy-token', user, config: clientConfig }),
  })
  await auth.loginWithPassword({ username: 'alice', password: 'pw' })
  expect(auth.accessToken()).toBe('legacy-token')
  await expect(readFile(gsRefreshTokenPath(dir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('funnels concurrent refreshes through one gateway call and rotates the sealed token', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const refreshCalls: string[] = []
  const { auth, dir } = await fixture({
    '/api/auth/login': () => json(200, loginResponse()),
    '/api/v1/auth/refresh': async (init) => {
      refreshCalls.push(bodyJson(init).refreshToken as string)
      await gate
      return json(200, { tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 3600 }, user, config: clientConfig })
    },
  })
  await auth.loginWithPassword({ username: 'alice', password: 'pw' })
  const first = auth.refreshTokens()
  const second = auth.refreshTokens()
  release()
  const [one, two] = await Promise.all([first, second])
  expect(one).toBe(two)
  expect(refreshCalls).toEqual(['rt-1'])
  expect(auth.accessToken()).toBe('at-2')
  const persisted = await readFile(gsRefreshTokenPath(dir), 'utf8')
  expect(Buffer.from(persisted.trim(), 'base64').toString('utf8')).toBe('sealed:rt-2')
})

it('wipes local state and reports expiry when the refresh family is rejected with 401', async () => {
  const onSessionLost = vi.fn()
  const { auth, dir } = await fixture({
    '/api/auth/login': () => json(200, loginResponse()),
    '/api/v1/auth/refresh': () => json(401, { code: 'token_expired', message: 'expired' }),
  }, { onSessionLost })
  await auth.loginWithPassword({ username: 'alice', password: 'pw' })
  await expect(auth.refreshTokens()).rejects.toMatchObject({ code: 'token_expired', status: 401 })
  expect(auth.snapshot()).toEqual({ status: 'signed-out' })
  expect(onSessionLost).toHaveBeenCalledExactlyOnceWith('expired')
  await expect(readFile(gsRefreshTokenPath(dir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports a 403 refresh rejection as disabled', async () => {
  const onSessionLost = vi.fn()
  const { auth } = await fixture({
    '/api/auth/login': () => json(200, loginResponse()),
    '/api/v1/auth/refresh': () => json(403, { code: 'account_disabled', message: 'disabled' }),
  }, { onSessionLost })
  await auth.loginWithPassword({ username: 'alice', password: 'pw' })
  await expect(auth.refreshTokens()).rejects.toMatchObject({ status: 403 })
  expect(onSessionLost).toHaveBeenCalledExactlyOnceWith('disabled')
})

it('restores a persisted session through a fresh state machine and refuses a revoked one', async () => {
  const routes: Record<string, Responder> = {
    '/api/auth/login': () => json(200, loginResponse()),
    '/api/v1/auth/refresh': () => json(200, { tokens: { accessToken: 'at-2', refreshToken: 'rt-2', expiresIn: 3600 }, user, config: clientConfig }),
  }
  const first = await fixture(routes)
  await first.auth.loginWithPassword({ username: 'alice', password: 'pw' })

  const reopen = (overrides: Record<string, Responder>): GsAuthService => {
    const { request } = gateway(overrides)
    return new GsAuthService({
      endpoint: () => 'http://127.0.0.1:8151/gsworker',
      stateDir: first.dir,
      protector: testProtector(),
      client: { platform: 'windows', version: '0.2.0-rc.2' },
      request,
    })
  }
  const restored = reopen(routes)
  await expect(restored.restoreSession()).resolves.toBe(true)
  expect(restored.accessToken()).toBe('at-2')
  // Single-flight: a second restore short-circuits on the live session.
  await expect(restored.restoreSession()).resolves.toBe(true)

  const revoked = reopen({ '/api/v1/auth/refresh': () => json(401, { code: 'token_expired', message: 'gone' }) })
  // The persisted token was rotated to rt-2 by the restore above; revocation resolves false.
  await expect(revoked.restoreSession()).resolves.toBe(false)

  const empty = await fixture({})
  await expect(empty.auth.restoreSession()).resolves.toBe(false)
})

it('adopts a host-issued token pair through the same sealing path as a login', async () => {
  const onSessionEstablished = vi.fn()
  const { auth, dir, calls } = await fixture({}, { onSessionEstablished })
  const snapshot = await auth.adoptTokens(
    { accessToken: 'at-9', refreshToken: 'rt-9', expiresIn: 3600 }, user, clientConfig,
  )
  expect(snapshot.status).toBe('signed-in')
  expect(auth.accessToken()).toBe('at-9')
  expect(calls).toEqual([])
  const persisted = await readFile(gsRefreshTokenPath(dir), 'utf8')
  expect(Buffer.from(persisted.trim(), 'base64').toString('utf8')).toBe('sealed:rt-9')
  expect(onSessionEstablished).toHaveBeenCalledExactlyOnceWith(user)
})

it('logout revokes best-effort and always wipes local state', async () => {
  const onSessionLost = vi.fn()
  const { auth, dir, calls } = await fixture({
    '/api/auth/login': () => json(200, loginResponse()),
    '/api/v1/auth/logout': () => { throw new TypeError('server gone') },
  }, { onSessionLost })
  await auth.loginWithPassword({ username: 'alice', password: 'pw' })
  await auth.logout()
  expect(auth.snapshot()).toEqual({ status: 'signed-out' })
  expect(calls.map(call => call.path)).toEqual(['/api/auth/login', '/api/v1/auth/logout'])
  expect(onSessionLost).not.toHaveBeenCalled()
  await expect(readFile(gsRefreshTokenPath(dir), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('normalizes email-code windows given in milliseconds', async () => {
  const { auth } = await fixture({
    '/api/auth/email/send-code': () => json(200, { ok: true, maskedEmail: 'a***@x.cn', expiresIn: 600_000, resendIn: 60_000 }),
  })
  await expect(auth.sendEmailCode('alice')).resolves.toEqual({
    ok: true, maskedEmail: 'a***@x.cn', expiresIn: 600, resendIn: 60,
  })
  expect(emailCodeWindowSeconds(300)).toBe(300)
  expect(emailCodeWindowSeconds(0)).toBe(0)
  expect(emailCodeWindowSeconds(Number.NaN)).toBe(0)
})
