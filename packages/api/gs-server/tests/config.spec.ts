/** ClientConfig cache: push, pull, clear, and subscriber notification. */
import { expect, it, vi } from 'vitest'
import type { GsRequest, GsSessionTokenSource } from '../src/client.ts'
import { GsClientConfigCache } from '../src/config.ts'
import type { GsAuthUser, GsClientConfig } from '../src/contract.ts'

const user: GsAuthUser = { id: 1, username: 'alice', displayName: 'Alice', role: 'user' }

function config(version: number): GsClientConfig {
  return {
    version,
    agent: { sandboxProfile: 'read-only', approvalPolicy: 'ask', dataClass: 'internal' },
    features: { customModel: false },
    settingsPages: {},
    permissions: { allowSubmit: true, allowExternalSkillInstall: false },
    skills: {},
    models: null,
    appUpdate: null,
    notice: null,
  }
}

function session(token: string | undefined = 'at-1'): GsSessionTokenSource {
  return { accessToken: () => token, refreshAccessToken: () => Promise.resolve('at-2') }
}

const signedOut: GsSessionTokenSource = { accessToken: () => undefined, refreshAccessToken: () => Promise.resolve('at-2') }

it('discards a config pull overtaken by logout', async () => {
  const response = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<undefined>()
  const cache = new GsClientConfigCache({
    endpoint: () => 'https://fixture.invalid', session: session(),
    request: async () => { started.resolve(undefined); return response.promise },
  })
  const pull = cache.getClientConfig()
  const rejected = expect(pull).rejects.toMatchObject({ code: 'unauthorized' })
  await started.promise
  cache.clear()
  response.resolve(Response.json({ user, config: config(7) }))
  await rejected
  expect(cache.snapshot()).toBeUndefined()
})

it('notifies subscribers on push, pull, and clear', async () => {
  const request: GsRequest = async () => new Response(JSON.stringify({ user, config: config(2) }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  const cache = new GsClientConfigCache({ endpoint: () => 'http://127.0.0.1:8151/gsworker', session: session(), request })
  const seen: unknown[] = []
  const unsubscribe = cache.subscribe((snapshot) => { seen.push(snapshot?.config.version ?? null) })

  expect(cache.snapshot()).toBeUndefined()
  cache.update(user, config(1))
  const pulled = await cache.getClientConfig()
  expect(pulled.config.version).toBe(2)
  expect(cache.snapshot()).toEqual({ user, config: config(2) })
  cache.clear()
  cache.clear() // second clear is a no-op: no extra notification
  unsubscribe()
  cache.update(user, config(3))
  expect(seen).toEqual([1, 2, null])
})

it('pulls through the authorized client and fails signed-out', async () => {
  const request: GsRequest = vi.fn<GsRequest>()
  const cache = new GsClientConfigCache({
    endpoint: () => 'http://127.0.0.1:8151/gsworker', session: signedOut, request,
  })
  await expect(cache.getClientConfig()).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
  expect(request).not.toHaveBeenCalled()
})
