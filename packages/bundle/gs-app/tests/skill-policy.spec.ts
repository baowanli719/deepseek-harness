/** Server local-skill permissions survive real Loader composition and scoped presets. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { boot, initProfile, readProfilePatches, reconcileProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import GsServer, { type GsClientConfig, type GsSessionView } from '@deepseek-ai/dsh-gs-server'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as gsSkills from '@deepseek-ai/dsh-gs-server-skills/src/index.ts'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as skillTool from '@deepseek-ai/dsh-tool-skill/src/index.ts'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import { sanitizeGsSkillEntries } from '../src/skill-policy.ts'

const filesystem = { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' }

class RecordedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  async *stream(request: GenerateOptions) {
    this.requests.push(request)
    yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
    yield { type: 'text-delta' as const, index: 0, text: '收到。' }
    yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: '收到。' } }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  }
}

it('denies generic discovery, alternative skill plugins, includes, and substituted identities recursively', () => {
  const input: EntryOptions[] = [
    { ...filesystem, disabled: false, group: true, config: [] },
    { id: 'renamed', name: filesystem.name },
    { id: 'tool-skill', name: 'fake-plugin' },
    { id: 'gs-server-skills', name: 'fake-plugin' },
    { id: 'extra', name: 'third-party-skill-provider' },
    { id: 'file', name: 'cordis:include', config: { path: 'extra.yml' } },
    { id: 'group', name: 'cordis:group', group: true, config: [filesystem] },
    { id: 'preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'test', plugins: [
      { name: filesystem.name }, { id: 'inner', name: 'cordis:group', group: true, config: [filesystem] },
    ] } },
  ]
  const before = JSON.stringify(input)
  const rows = sanitizeGsSkillEntries(input)
  expect(rows.slice(0, 6).every(row => row.disabled === true && row.group === false)).toBe(true)
  expect(rows[6]).toMatchObject({ config: [{ disabled: true, group: false }] })
  expect(rows[7]).toMatchObject({ config: { plugins: [
    { disabled: true }, { config: [{ disabled: true }] },
  ] } })
  expect(JSON.stringify(input)).toBe(before)
  expect(sanitizeGsSkillEntries(rows)).toEqual(rows)
})

it('retains canonical GS providers, skill tools, UI, and bundled skills', () => {
  const rows: EntryOptions[] = [
    { id: 'gs-server-skills', name: '@deepseek-ai/dsh-gs-server-skills' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'skill', name: '@deepseek-ai/dsh-skill' },
    { id: 'ui-skills-gs', name: '@deepseek-ai/dsh-client-ui-skills-gs' },
    { id: 'skill-badge', name: '@deepseek-ai/dsh-skill-badge' },
    { id: 'ordinary-tool', name: 'cordis:noop' },
  ]
  expect(sanitizeGsSkillEntries(rows)).toEqual(rows)
})

it('enforces live server permissions through the Loader, registry, and newly mounted presets', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gs-skill-policy-'))
  let root: Context | undefined
  const owned: { unregister?: () => Promise<void> } = {}
  onTestFinished(async () => { await owned.unregister?.(); await root?.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const dir = join(home, 'profile')
  initProfile(dir, ['test-skill-bundle'])
  const bundle = join(dir, 'node_modules', 'test-skill-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-skill-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  const managedRoot = join(home, 'managed')
  const localRoot = join(home, 'user-local')
  await mkdir(join(managedRoot, 'allowed-local'), { recursive: true })
  await mkdir(join(home, '.agents', 'skills', 'rogue-local'), { recursive: true })
  await writeFile(join(managedRoot, 'allowed-local', 'SKILL.md'),
    '---\nname: allowed-local\ndescription: Controlled skill\n---\n\nLOCAL BODY\n')
  await writeFile(join(home, '.agents', 'skills', 'rogue-local', 'SKILL.md'),
    '---\nname: rogue-local\ndescription: Uncontrolled skill\n---\n\nROGUE BODY\n')
  let config: GsClientConfig = {
    version: 1, agent: { sandboxProfile: 'tool-mediated', approvalPolicy: 'policy-auto', dataClass: 'public' },
    features: { customModel: false }, settingsPages: {},
    permissions: { allowSubmit: true, allowExternalSkillInstall: false, allowLocalSkillCreate: true },
    skills: {}, models: null, appUpdate: null, notice: null,
  }
  class RemoteServer extends GsServer {
    override async [Service.init](): Promise<void> {}
    override getClientConfig(): GsClientConfig { return config }
    override getAccessToken(): Promise<string> { return Promise.resolve('test-token') }
    override sessionView(): GsSessionView { return { status: 'signed-out', endpoint: 'https://gs.example.test' } }
    override fetch(path: string): Promise<Response> {
      if (path === '/api/v1/meta') return Promise.resolve(Response.json({}))
      if (path === '/api/v1/skills/catalog') return Promise.resolve(Response.json({ skills: [] }))
      return Promise.reject(new Error(`Unexpected server request: ${path}`))
    }
  }
  const preset = { id: 'standard', plugins: [filesystem,
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'nested', name: 'cordis:group', group: true, config: [{ id: 'renamed', name: filesystem.name }] },
  ] }
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'llm', name: 'cordis:llm' }, { id: 'sessions', name: 'cordis:sessions' },
    { id: 'projections', name: 'cordis:projections' }, { id: 'prompt', name: 'cordis:prompt' },
    { id: 'tools', name: 'cordis:tools' }, { id: 'agents', name: 'cordis:agents' },
    { id: 'loop', name: 'cordis:loop', config: { agents: [] } },
    { id: 'registry', name: 'cordis:registry' },
    { id: 'server', name: 'cordis:server', config: { stateDir: join(home, 'server'), clientVersion: 'test' } },
    { id: 'gs', name: 'cordis:gs', config: { localSkillManagedRoot: managedRoot, localSkillHomeRoot: localRoot,
      preferenceRoot: join(home, 'preferences'), bundleCacheRoot: join(home, 'bundles') } },
    filesystem,
    { id: 'presets', name: 'cordis:presets', config: { default: 'standard' } },
    { id: 'preset-standard', name: 'cordis:preset', config: preset },
  ] }]))
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([{ id: 'skill-filesystem', disabled: false }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-skill-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    // Bind the admitted production tool to this test Loader's framework copy.
    transformEntries: entries => sanitizeGsSkillEntries(entries).map(row => row.name === '@deepseek-ai/dsh-tool-skill'
      && row.disabled !== true ? { ...row, name: 'cordis:catalog' } : row),
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    root = ctx
    ctx.provide('profileContext', profile)
    Object.assign(ctx.loader.builtins, {
      llm: LlmRuntime, sessions: SessionStore, projections: Projections, prompt: SystemPrompt,
      tools: Tools, agents: AgentRegistry, loop: AgentLoop, registry: SkillRegistry,
      server: RemoteServer, gs: gsSkills, presets: Presets, preset: AgentPreset, catalog: skillTool,
    })
  })
  const agent = await ctx.agentLoop.create(SessionId('local-policy'), { provider: 'test', model: 'test' })
  await ctx.agentPresets.mount(agent.ctx)
  const adapter = new RecordedAdapter()
  ctx.llm.registerAdapter(['test'], adapter)
  const recordTurn = async () => {
    const before = agent.session.snapshotEvents().length
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '/allowed-local /rogue-local' }] }))
    await agent.whenIdle()
    const replay = Session.create(agent.id, agent.session.snapshotEvents())
    expect(adapter.requests.at(-1)?.messages).toEqual(replay.deriveMessages().slice(0, -1))
    return agent.session.snapshotEvents().slice(before).flatMap<{ kind: 'skill-catalog' | 'skill-invocation'; names: string[] }>((event) => {
      if (event.type !== 'user/message') return []
      const source = event.data.source
      if (source.kind === 'skill-catalog') return [{ kind: source.kind, names: source.entries.map(entry => entry.name) }]
      if (source.kind === 'skill-invocation') return [{ kind: source.kind, names: [source.name] }]
      return []
    })
  }
  const options = { cwd: home, scope: scopeOf(agent.ctx) }
  expect(options.scope).toBeDefined()
  expect(await ctx.skills.get('rogue-local', options)).toBeUndefined()
  expect((await ctx.skills.get('allowed-local', options))?.content).toBe('LOCAL BODY')
  const enabled = await recordTurn()
  config = { ...config, permissions: { ...config.permissions, allowLocalSkillCreate: false } }
  ctx.emit('gs-server/client-config-changed', config)
  expect(await ctx.skills.list(options)).toMatchObject([{ name: 'allowed-local',
    invocation: { modelInvocable: false, userInvocable: false } }])
  expect(await ctx.skills.get('allowed-local', options)).toBeUndefined()
  const disabled = await recordTurn()
  config = { ...config, permissions: { ...config.permissions, allowLocalSkillCreate: true } }
  ctx.emit('gs-server/client-config-changed', config)
  expect((await ctx.skills.get('allowed-local', options))?.content).toBe('LOCAL BODY')
  const restored = await recordTurn()
  expect({ enabled, disabled, restored }).toMatchInlineSnapshot(`
    {
      "disabled": [
        {
          "kind": "skill-catalog",
          "names": [],
        },
      ],
      "enabled": [
        {
          "kind": "skill-catalog",
          "names": [
            "allowed-local",
          ],
        },
        {
          "kind": "skill-invocation",
          "names": [
            "allowed-local",
          ],
        },
      ],
      "restored": [
        {
          "kind": "skill-catalog",
          "names": [
            "allowed-local",
          ],
        },
        {
          "kind": "skill-invocation",
          "names": [
            "allowed-local",
          ],
        },
      ],
    }
  `)
  // A new preset goes through admission again, even without a profile-file reload.
  owned.unregister = await ctx.agentPresets.register({ id: 'late', plugins: [{ name: filesystem.name }] })
  const next = await ctx.agentLoop.create(SessionId('late-policy'), { provider: 'test', model: 'test' })
  await ctx.agentPresets.mount(next.ctx, 'late')
  expect(await ctx.skills.get('rogue-local', { cwd: home, scope: scopeOf(next.ctx) })).toBeUndefined()
  await writeFile(profile.patchPath, JSON.stringify([
    { id: 'skill-filesystem', disabled: false },
    { id: 'preset-standard', config: { id: 'standard', plugins: [{ id: 'reintroduced', name: filesystem.name }] } },
  ]))
  await reconcileProfilePatches(ctx, readProfilePatches('test', profile), 'test')
  const reloaded = await ctx.agentLoop.create(SessionId('reload-policy'), { provider: 'test', model: 'test' })
  await ctx.agentPresets.mount(reloaded.ctx)
  expect(await ctx.skills.get('rogue-local', { cwd: home, scope: scopeOf(reloaded.ctx) })).toBeUndefined()
  expect((await ctx.skills.get('allowed-local', { cwd: home, scope: scopeOf(reloaded.ctx) }))?.content).toBe('LOCAL BODY')
}, 15000)
