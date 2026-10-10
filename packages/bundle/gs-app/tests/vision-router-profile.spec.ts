/** The shipped visual plugin boots through Loader and sends attachment pixels through the GS gateway. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as Gateway from '@deepseek-ai/dsh-llm-gs-gateway'
import * as Vision from 'dsh-vision-router'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'

class TextAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  override providerInfo() { return { id: 'gs-cloud', name: 'Server models' } }
  override async listModels() { return [await this.resolveModel()] }
  override async resolveModel() {
    return { provider: 'gs-cloud', id: 'text-model', name: 'Text model', inputModalities: ['text'] as const }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('automatically configures and executes the installed plugin without changing the primary model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gs-vision-profile-'))
  let root: Context | undefined
  onTestFinished(async () => { await root?.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const dir = join(home, 'profile')
  initProfile(dir, ['test-vision-bundle'])
  const bundle = join(dir, 'node_modules', 'test-vision-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-vision-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-vision-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'credentials', name: 'cordis:credentials', config: { path: join(home, '.credentials.yaml'), watch: false } },
    { id: 'system-prompt', name: 'cordis:system' },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'llm', name: 'cordis:llm' },
    { id: 'agent-default-model', name: 'cordis:model', config: { provider: 'gs-cloud', model: 'text-model' } },
    { id: 'vision-router', name: 'cordis:vision', config: {
      desktopToolMode: true, freeFallback: false, updateCheck: false, progressiveTools: false,
      onboardingSeen: true, downscale: false, autoWrapProviders: false,
    } },
    { id: 'llm-gs-gateway', name: 'cordis:gateway', config: { visionRouterNamespace: 'vision-router' } },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-vision-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const calls: { path: string; body: Record<string, unknown>; sensitive: string | null }[] = []
  const adapter = new TextAdapter()
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    root = ctx
    ctx.provide('profileContext', profile)
    ctx.provide('gsServer', {
      getAccessToken: () => Promise.resolve('test-access'),
      getClientConfig: () => ({ models: { providers: {} } }),
      fetch: (path: string, init?: RequestInit) => {
        if (!(init?.body instanceof Uint8Array)) throw new Error('Expected the proxy buffered request body')
        const body = JSON.parse(Buffer.from(init.body).toString('utf8')) as Record<string, unknown>
        calls.push({ path, body, sensitive: new Headers(init.headers).get('x-gsclaw-sensitive') })
        return Promise.resolve(Response.json({ choices: [{ message: { content: '图片是一枚白色像素。' } }] }))
      },
    } as never)
    ctx.provide('launchEnvironment', Gateway.gsLlmGatewayLaunchEnvironment(
      createLaunchEnvironmentSnapshot([]), Gateway.createGsLlmGatewayToken(),
    ))
    Object.assign(ctx.loader.builtins, {
      editor: ConfigEditor, settings: Settings, model: DefaultModel, gateway: Gateway,
      vision: Vision, llm: LlmRuntime, tools: ToolRuntime, system: SystemPrompt, credentials: LocalCredentials,
    })
    ctx.inject(['llm'], ctx => ctx.effect(() => ctx.llm.registerAdapter(['gs-cloud'], adapter)))
  })
  await vi.waitFor(() => {
    expect(ctx.get('visionToolAdmission')?.canHandle({ session: { id: 'image-session' } })).toBe(true)
  }, { timeout: 10000 })
  const patch = await readFile(profile.patchPath, 'utf8')
  expect(patch).toContain('/vision')
  expect(patch).toContain('server-vision')
  expect(patch).not.toContain(ctx.gsLlmGateway.token)
  expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['gs-cloud'])
  const ref = { attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png' as const, width: 1, height: 1, bytes: 68 }
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: ref }] })
  const sessionId = SessionId('image-session')
  const original = JSON.stringify(message)
  const options = { provider: 'gs-cloud', model: 'text-model', sessionId, messages: [message] }
  const prepared = await ctx.llm.prepareCall({ provider: 'gs-cloud', model: 'text-model' })
  const chunks: StreamChunk[] = []
  for await (const chunk of prepared.stream(options)) chunks.push(chunk)
  expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  expect(adapter.calls).toHaveLength(1)
  expect(JSON.stringify(adapter.calls[0]?.messages)).toContain(String(ref.attachmentId))
  expect(JSON.stringify(adapter.calls[0]?.messages)).toContain('vision_describe')
  expect(adapter.calls[0]?.messages.map(row => row.content)).toMatchSnapshot('text model attachment guidance')
  expect(JSON.stringify(message)).toBe(original)
  const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=', 'base64')
  const images = new Map([[ref.attachmentId, { ref, data: pixels }]])
  ctx.provide('attachments', { readImage: (image: typeof ref) => Promise.resolve(images.get(image.attachmentId)) } as never)
  const session = Session.create(sessionId)
  session.append('user/message', message, { surfaceOp: 'append' })
  const agent = { id: sessionId, ctx, session } as never
  const result = await ctx.tools.execute({ agent, signal: new AbortController().signal,
    callId: ToolCallId('vision-test'), name: 'vision_describe',
    arguments: { attachmentIds: [ref.attachmentId], question: '描述图片' },
  })
  expect(JSON.stringify(result)).toContain('图片是一枚白色像素')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.path).toBe('/api/v1/llm/vision/chat/completions')
  expect(calls[0]?.sensitive).toBe('1')
  expect(JSON.stringify(calls[0]?.body)).toContain('data:image/png;base64,')
  expect(calls[0]?.body.model).toBe('server-vision')
  expect(calls[0]?.body).toMatchSnapshot('server-managed vision request')
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'vision-router')!
  await ctx.configEditor.edit(entry, current => ({ ...current, freeFallback: true, autoWrapProviders: true }))
  ctx.emit('gs-server/client-config-changed', { models: { providers: {} } } as never)
  const second = await ctx.tools.execute({ agent, signal: new AbortController().signal,
    callId: ToolCallId('vision-second'), name: 'vision_describe',
    arguments: { attachmentIds: [ref.attachmentId], question: '提取文字' },
  })
  expect(JSON.stringify(second)).toContain('图片是一枚白色像素')
  expect(calls.map(call => call.path)).toEqual([
    '/api/v1/llm/vision/chat/completions', '/api/v1/llm/vision/chat/completions',
  ])
  expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['gs-cloud'])
  const noisyPixels = await sharp(randomBytes(96 * 96 * 3), { raw: { width: 96, height: 96, channels: 3 } }).png().toBuffer()
  const largeRefs = ['b', 'c'].map(letter => ({ ...ref,
    attachmentId: AttachmentId(`sha256:${letter.repeat(64)}`), width: 96, height: 96, bytes: noisyPixels.length,
  }))
  for (const largeRef of largeRefs) images.set(largeRef.attachmentId, { ref: largeRef, data: noisyPixels })
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content:
    largeRefs.map(attachment => ({ type: 'image' as const, attachment })),
  }), { surfaceOp: 'append' })
  await ctx.configEditor.edit(entry, current => ({ ...current,
    httpProviders: (current.httpProviders as Record<string, unknown>[]).map(provider => ({ ...provider, maxImageBodyBytes: 16000 })),
  }))
  const bounded = await ctx.tools.execute({ agent, signal: new AbortController().signal,
    callId: ToolCallId('vision-bounded'), name: 'vision_describe',
    arguments: { attachmentIds: largeRefs.map(image => image.attachmentId), question: '比较两张图片' },
  })
  expect(JSON.stringify(bounded)).toContain('图片是一枚白色像素')
  expect(calls).toHaveLength(3)
  const urls = JSON.stringify(calls[2]?.body).match(/data:image\/jpeg;base64,[A-Za-z0-9+/=]+/g) ?? []
  expect(urls).toHaveLength(2)
  expect(urls.reduce((total, url) => total + Buffer.from(url.split(',')[1]!, 'base64').length, 0)).toBeLessThanOrEqual(16000)
  expect(JSON.stringify(calls[2]?.body).length).toBeLessThan(4 * 1024 * 1024)
  await ctx.configEditor.edit(entry, current => ({ ...current,
    httpProviders: (current.httpProviders as Record<string, unknown>[]).map(provider => ({ ...provider, maxImageBodyBytes: 32 })),
  }))
  const refused = await ctx.tools.execute({ agent, signal: new AbortController().signal,
    callId: ToolCallId('vision-too-small'), name: 'vision_describe',
    arguments: { attachmentIds: largeRefs.map(image => image.attachmentId), question: '再次检查图片' },
  })
  expect(JSON.stringify(refused)).toContain('VISION_IMAGE_PREPROCESS_FAILED')
  expect(calls).toHaveLength(3)
  await ctx.configEditor.edit(entry, current => ({ ...current, tool: false }))
  await vi.waitFor(() => { expect(ctx.get('visionToolAdmission')?.canHandle({ session: { id: sessionId } })).toBe(false) })
  const disabledChunks: StreamChunk[] = []
  const disabledCall = await ctx.llm.prepareCall({ provider: 'gs-cloud', model: 'text-model' })
  for await (const chunk of disabledCall.stream(options)) disabledChunks.push(chunk)
  expect(disabledChunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  expect(JSON.stringify(adapter.calls.at(-1)?.messages)).not.toContain('vision_describe')
  expect(JSON.stringify(message)).toBe(original)
  await ctx.fiber.dispose()
  root = undefined
  expect(ctx.get('visionToolAdmission')).toBeUndefined()
}, 30000)
