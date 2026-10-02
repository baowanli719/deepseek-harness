/** A restored session must not block Loader boot while mirroring its model plan. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as Gateway from '../src/index.ts'

it('boots a real profile with cached models and commits the restored plan after activation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gs-gateway-startup-'))
  let root: Context | undefined
  onTestFinished(async () => {
    await root?.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profile')
  initProfile(dir, ['test-gs-bundle'])
  const bundle = join(dir, 'node_modules', 'test-gs-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-gs-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-gs-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: 'llm-pi-ai', name: 'cordis:provider' },
    { id: 'agent-default-model', name: 'cordis:model', config: { provider: 'local', model: 'previous' } },
    { id: 'llm-gs-gateway', name: 'cordis:gateway' },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-gs-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    root = ctx
    ctx.provide('profileContext', profile)
    ctx.provide('gsServer', {
      getAccessToken: () => Promise.resolve('test-access'),
      fetch: () => Promise.reject(new Error('no model request expected')),
      getClientConfig: () => ({ models: {
        providers: { 'gs-cloud': { api: 'openai-completions', models: [{ id: 'qwen-max' }] } },
        defaultPrimary: 'gs-cloud/qwen-max',
      } }),
    } as never)
    Object.assign(ctx.loader.builtins, {
      editor: ConfigEditor, settings: Settings, model: DefaultModel, gateway: Gateway,
      provider: {
        Config: z.object({ providers: z.dict(z.object({})).default({}).volatile() }),
        apply: () => {},
      },
    })
  })
  expect(ctx.get('gsLlmGateway')).toBeDefined()
  await vi.waitFor(() => {
    expect(ctx.settings.describe().find(row => row.ns === 'agent-default-model')?.value)
      .toMatchObject({ provider: 'gs-cloud', model: 'qwen-max' })
  })
  expect(await readFile(profile.patchPath, 'utf8')).toContain('gs-cloud')
  const origin = ctx.gsLlmGateway.origin
  await ctx.fiber.dispose()
  root = undefined
  expect(ctx.get('gsLlmGateway')).toBeUndefined()
  await expect(fetch(origin)).rejects.toThrow()
}, 8000)
