/** Product prompt rules survive real profile loading, scoped presets, and session logging. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import PresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import * as Persona from '@deepseek-ai/dsh-persona'
import * as language from '../src/prompt-language.ts'
import { OFFICE_PERSONA, sanitizeGsPromptPatches } from '../src/prompt-policy.ts'

class CaptureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  async *stream(request: GenerateOptions) {
    this.requests.push(request)
    yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
    yield { type: 'text-delta' as const, index: 0, text: '收到。' }
    yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: '收到。' } }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  }
}

it.each([false, true])('keeps office identity and language in a scoped preset, complete=%s', async (complete) => {
  const home = await mkdtemp(join(tmpdir(), 'gs-prompt-policy-'))
  let root: Context | undefined
  onTestFinished(async () => { await root?.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const dir = join(home, 'profile')
  initProfile(dir, ['test-prompt-bundle'])
  const bundle = join(dir, 'node_modules', 'test-prompt-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-prompt-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-prompt-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  const presetConfig = { id: 'standard', plugins: [{
    id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'You are a coding agent.', complete },
  }] }
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'llm', name: 'cordis:llm' },
    { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' },
    { id: 'system-prompt', name: 'cordis:prompt', config: { includeHarnessIdentity: false, personaPrefix: 'Old persona' } },
    { id: 'tools', name: 'cordis:tools' },
    { id: 'agents', name: 'cordis:agents' },
    { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'language', name: 'cordis:language' },
    { id: 'presets', name: 'cordis:presets', config: { default: 'standard' } },
    { id: 'preset-standard', name: '@deepseek-ai/dsh-agent-preset', config: presetConfig },
  ] }]))
  // The user's later config patch is also subject to the product policy.
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([{ id: 'preset-standard', config: presetConfig }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-prompt-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    transformPatches: sanitizeGsPromptPatches,
  }
  const patches = readProfilePatches('test', profile)
  // Bind the same production Persona to this test Loader, avoiding a second installed framework copy.
  for (const patch of patches) {
    for (const row of patch.insert ?? []) if (row.name === '@deepseek-ai/dsh-agent-preset') row.name = 'cordis:preset'
    const configs: unknown[] = [patch.config, ...patch.insert?.map((row): unknown => row.config) ?? []]
    for (const config of configs) {
      if (typeof config !== 'object' || config === null || !('plugins' in config) || !Array.isArray(config.plugins)) continue
      for (const entry of config.plugins) {
        const row: unknown = entry
        if (typeof row === 'object' && row !== null && 'name' in row && row.name === '@deepseek-ai/dsh-persona') {
          row.name = 'cordis:persona'
        }
      }
    }
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), patches, (ctx) => {
    root = ctx
    ctx.provide('profileContext', profile)
    Object.assign(ctx.loader.builtins, {
      llm: LlmRuntime, sessions: SessionStore, projections: SessionProjections, prompt: SystemPrompt,
      tools: Tools, agents: AgentRegistry, loop: AgentLoop, language, presets: PresetRegistry, preset: AgentPreset,
    })
    // Preset child rows use the real Persona plugin under their own Loader scope.
    ctx.loader.builtins.persona = Persona
  })
  const adapter = new CaptureAdapter()
  ctx.llm.registerAdapter(['test'], adapter)
  ctx.systemPrompt.section({ name: 'test:english-skill', order: 500, text: 'Use this skill to create Word documents.' })
  const agent = await ctx.agentLoop.create(SessionId('gs-language'), { provider: 'test', model: 'test' })
  await ctx.agentPresets.mount(agent.ctx)
  for (const input of ['请整理文档要点。', 'Please answer in English.']) {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: input }] }))
    await agent.whenIdle()
  }
  expect(adapter.requests).toHaveLength(2)
  for (const request of adapter.requests) {
    const system = request.messages.filter(message => message.role === 'system').flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(system).toContain(OFFICE_PERSONA)
    expect(system).toContain(language.LANGUAGE_DIRECTIVE)
    expect(system).not.toContain('You are a coding agent')
    expect(system.includes('Use this skill')).toBe(!complete)
    expect(request.messages.some(message => message.source?.kind === 'gs-prompt-language')).toBe(true)
  }
  expect(adapter.requests[1]?.messages.some(message => message.content.some(block =>
    block.type === 'text' && block.text === 'Please answer in English.'))).toBe(true)
  const replay = Session.create(agent.id, agent.session.snapshotEvents())
  expect(adapter.requests[1]?.messages).toEqual(replay.deriveMessages().slice(0, -1))
  const reloaded = readProfilePatches('test', profile)
  expect(JSON.stringify(reloaded)).not.toContain('You are a coding agent')
}, 15000)

it('preserves complete persona choices and unrelated patches without mutating input', () => {
  const input = [{ id: 'preset-minimal', config: { id: 'minimal', plugins: [{
    name: '@deepseek-ai/dsh-persona', config: { prefix: 'Old', suffix: 'Workspace {{cwd}}.', complete: true, includeRuntimeContext: false },
  }, { name: 'cordis:group', config: [] }] } }, { id: 'unrelated', disabled: true }]
  const output = sanitizeGsPromptPatches(input)
  expect(output[0]?.config).toMatchObject({ plugins: [{ config: {
    prefix: `${OFFICE_PERSONA}\n\n${language.LANGUAGE_DIRECTIVE}`, suffix: 'Workspace {{cwd}}.', complete: true, includeRuntimeContext: false,
  } }, { name: 'cordis:group', config: [] }] })
  expect(output[1]).toEqual(input[1])
  expect(input[0]?.config?.plugins[0]?.config).toMatchObject({ prefix: 'Old' })
})
