/** Authenticated source reads through a Loader-owned real HTTP server. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { GatewayError } from '@deepseek-ai/dsh-gs-server'
import * as preview from '../src/link-preview.ts'

async function server(maxResponseBytes = 2 * 1024 * 1024, requestTimeoutMs = 120_000) {
  const home = await mkdtemp(join(tmpdir(), 'gs-link-reader-'))
  let root: Context | undefined
  onTestFinished(async () => { await root?.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const endpoint = 'https://gs.example.test/gsclaw'
  let signedIn = true
  const upstream = vi.fn<(path: string, init: RequestInit) => Promise<Response>>(async () =>
    Response.json({ fileId: '123', fileName: '制度', content: '原文', truncated: false }))
  const dir = join(home, 'profile')
  initProfile(dir, ['test-reader-bundle'])
  const bundle = join(dir, 'node_modules', 'test-reader-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-reader-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-reader-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'web', name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    { id: 'server', name: 'cordis:server' },
    { id: 'preview', name: 'cordis:preview', config: { maxResponseBytes, requestTimeoutMs } },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-reader-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    root = ctx
    ctx.provide('profileContext', profile)
    Object.assign(ctx.loader.builtins, {
      web: WebServer, preview,
      server: { apply(ctx: Context) {
        ctx.provide('gsServer', {
          sessionView: () => ({ status: signedIn ? 'signed-in' : 'signed-out', endpoint }), fetch: upstream,
        } as never)
      } },
    })
  })
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  return {
    upstream, signOut: () => { signedIn = false },
    request: (url: string | null = `${endpoint}/api/v1/zhidu/files/123`, headers = { origin }, method = 'GET', signal?: AbortSignal) =>
      fetch(`${origin}/api/gs-server/link-preview${url === null ? '' : `?url=${encodeURIComponent(url)}`}`, {
        headers, method, ...(signal === undefined ? {} : { signal }),
      }),
  }
}

it('reads a large Chinese source without the model JSON byte cap and preserves plain-text fallbacks', async () => {
  const h = await server()
  h.upstream.mockResolvedValueOnce(Response.json({ fileName: '制度', content: '甲'.repeat(450_000), truncated: false }))
  const response = await h.request()
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(await response.json()).toMatchObject({ fileName: '制度', content: '甲'.repeat(450_000), truncated: false })
  expect(h.upstream.mock.calls[0]?.[0]).toBe('/api/v1/zhidu/files/123')
  expect(h.upstream.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' })
  expect(h.upstream.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
  h.upstream.mockResolvedValueOnce(Response.json({ fileName: null, content: '{半截 JSON', truncated: true }))
  expect(await (await h.request()).json()).toEqual({ fileName: null, content: '{半截 JSON', truncated: true })
  h.upstream.mockResolvedValueOnce(new Response('<script>literal source</script>'))
  expect(await (await h.request()).json()).toEqual({ fileName: null, content: '<script>literal source</script>', truncated: false })
})

it('rejects unrelated destinations and cross-site requests before using credentials', async () => {
  const h = await server()
  for (const url of [
    'https://evil.test/gsclaw/api/v1/zhidu/files/123', 'https://gs.example.test/api/v1/zhidu/files/123',
    'https://user:pass@gs.example.test/gsclaw/api/v1/zhidu/files/123',
    'https://gs.example.test/gsclaw/api/v1/zhidu/files/123?token=x',
    'https://gs.example.test/gsclaw/api/v1/zhidu/files/123#fragment',
    'https://gs.example.test/gsclaw/api/v1/zhidu/files/123/extra',
    'https://gs.example.test/gsclaw/api/v1/zhidu/files/uuid', 'invalid',
  ]) {
    const response = await h.request(url)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'source_endpoint_mismatch' })
  }
  expect((await h.request(undefined, { origin: 'https://evil.test' })).status).toBe(403)
  expect((await h.request(undefined, undefined, 'POST')).status).toBe(405)
  expect((await h.request(null)).status).toBe(409)
  expect(h.upstream).not.toHaveBeenCalled()
  h.signOut()
  expect((await h.request()).status).toBe(401)
  expect(h.upstream).not.toHaveBeenCalled()
})

it('preserves authentication failures and bounds upstream byte consumption', async () => {
  const h = await server(32)
  for (const status of [401, 403, 404, 500]) {
    h.upstream.mockResolvedValueOnce(new Response('not forwarded', { status }))
    expect((await h.request()).status).toBe(status === 500 ? 502 : status)
  }
  h.upstream.mockRejectedValueOnce(new GatewayError('unauthorized', 401, 'not signed in'))
  expect((await h.request()).status).toBe(401)
  h.upstream.mockResolvedValueOnce(new Response('甲'.repeat(11)))
  expect((await h.request()).status).toBe(502)
  h.upstream.mockResolvedValueOnce(new Response('a'.repeat(32)))
  expect((await h.request()).status).toBe(200)
})

it('stops reading a stalled response when its configured deadline expires', async () => {
  const h = await server(1024, 25)
  const cancel = vi.fn()
  h.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
  expect((await h.request()).status).toBe(502)
  expect(cancel).toHaveBeenCalledOnce()
})

it('handles empty and failed streams without retaining unread bodies', async () => {
  const h = await server()
  h.upstream.mockResolvedValueOnce(new Response(null))
  expect(await (await h.request()).json()).toMatchObject({ content: '', truncated: false })
  h.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream failed')) } })))
  expect((await h.request()).status).toBe(502)
})

it('contains a transport cancellation failure at the read deadline', async () => {
  const h = await server(1024, 25)
  h.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ cancel() { throw new Error('already disconnected') } })))
  expect((await h.request()).status).toBe(502)
})

it('cancels the upstream stream when the reader disconnects', async () => {
  const h = await server()
  const cancel = vi.fn()
  h.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
  const controller = new AbortController()
  const pending = h.request(undefined, undefined, undefined, controller.signal).catch((error: unknown) => error)
  await vi.waitFor(() => { expect(h.upstream).toHaveBeenCalledOnce() })
  controller.abort()
  await pending
  await vi.waitFor(() => { expect(cancel).toHaveBeenCalledOnce() })
  expect(h.upstream.mock.calls[0]?.[1].signal?.aborted).toBe(true)
})

it('refuses a carrier request without a request target before using credentials', async () => {
  const ctx = new Context()
  const upstream = vi.fn()
  let handler: WebRoute['handler'] = () => { throw new Error('route not registered') }
  ctx.provide('webServer', { port: 1234, register(route: WebRoute) { handler = route.handler; return () => {} } } as never)
  ctx.provide('gsServer', {
    sessionView: () => ({ status: 'signed-in', endpoint: 'https://gs.example.test/gsclaw' }), fetch: upstream,
  } as never)
  try {
    preview.apply(ctx, { maxResponseBytes: 1024, requestTimeoutMs: 1000 })
    const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() }
    await handler({ method: 'GET', headers: { host: '127.0.0.1:1234', origin: 'http://127.0.0.1:1234' },
      socket: { remoteAddress: '127.0.0.1' } } as never, response as never)
    expect(response.statusCode).toBe(409)
    expect(upstream).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
  }
})
