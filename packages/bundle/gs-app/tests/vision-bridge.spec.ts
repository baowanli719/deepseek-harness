/**
 * Real-composition tests for the gs-vision-bridge plugin: a genuine Cordis
 * context carries the tool registry, the bridge mounts a real mcp-client
 * stdio connection to the real mcp-vision-server child, and the tool call
 * round-trips through a stub loopback proxy that stands in for gsLlmGateway's
 * upstream. No gsclaw-server or model API is involved.
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as visionBridge from '../src/vision-bridge.ts'
import type { GsLlmGateway } from '@deepseek-ai/dsh-llm-gs-gateway'

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

interface ProxyObservation {
  method?: string | undefined
  url?: string | undefined
  authorization?: string | undefined
  body?: string | undefined
}

/** Stub loopback proxy: records the last request and answers a fixed chat completion. */
async function startStubProxy(): Promise<{ server: Server; origin: string; observed: ProxyObservation }> {
  const observed: ProxyObservation = {}
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      observed.method = request.method
      observed.url = request.url
      observed.authorization = request.headers.authorization
      observed.body = Buffer.concat(chunks).toString('utf8')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: '图中是一张测试图片' } }] }))
    })
  })
  await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  const { port } = server.address() as AddressInfo
  return { server, origin: `http://127.0.0.1:${String(port)}`, observed }
}

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

describe('gs-vision-bridge', () => {
  describe('mounted with a live gateway', () => {
    let ctx: Context
    let proxy: Server
    let workDir: string
    let observed: ProxyObservation

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), 'gs-vision-bridge-'))
      const stub = await startStubProxy()
      proxy = stub.server
      observed = stub.observed
      ctx = await mountRegistry()
      const gateway: GsLlmGateway = {
        origin: stub.origin,
        token: 'per-boot-token',
        providerBaseUrl: (providerId: string) => `${stub.origin}/v1/${providerId}`,
      }
      ctx.provide('gsLlmGateway', gateway)
      await ctx.plugin(visionBridge, {
        serverName: 'vision',
        toolCallTimeoutMs: 15_000,
      })
    }, 60_000)

    afterAll(async () => {
      if (ctx) await ctx.fiber.dispose()
      proxy.close()
      await rm(workDir, { recursive: true, force: true })
    })

    it('registers the vision tool under the server namespace', () => {
      const names = ctx.tools.schemas().map(schema => schema.name)
      expect(names).toContain('mcp__vision__analyze_image')
    })

    it('executes analyze_image end to end through the stub proxy', async () => {
      const file = join(workDir, 'pixel.png')
      await writeFile(file, PNG)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('gs-vision-bridge-e2e-1'),
        name: 'mcp__vision__analyze_image',
        arguments: { path: file, prompt: '描述画面内容' },
      })
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: 'text', text: '图中是一张测试图片' }])
      // The child received the per-boot token through its env carve-out and
      // posted the server-selected vision route.
      expect(observed.method).toBe('POST')
      expect(observed.url).toBe('/vision/chat/completions')
      expect(observed.authorization).toBe('Bearer per-boot-token')
      const body = JSON.parse(observed.body ?? '{}') as { model?: string; messages?: unknown[] }
      expect(body).not.toHaveProperty('model')
      expect(body.messages).toHaveLength(1)
    }, 30_000)
  })

  it('stays unmounted without the gateway service instead of failing the boot', async () => {
    const ctx = await mountRegistry()
    await ctx.plugin(visionBridge, {
      serverName: 'vision',
      toolCallTimeoutMs: 15_000,
    })
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('mcp__vision__analyze_image')
    await ctx.fiber.dispose()
  })
})
