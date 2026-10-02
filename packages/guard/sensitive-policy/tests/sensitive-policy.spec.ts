/**
 * Unit + real-load-path coverage for @deepseek-ai/dsh-sensitive-policy.
 *
 * The gs-server client is mocked at the service boundary (a provided
 * `gsServer` object whose ClientConfig holder the test rewrites); the tool
 * pipeline runs the real ToolRuntime so egress denial is asserted through the
 * executor, and the LLM boundary is driven through the real `llm/stream`
 * waterfall dispatch.
 */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentCancelCause, SessionEvent } from '@deepseek-ai/dsh-session'
import { Session, SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import type { GsClientConfig, GsModelProviderEntry } from '@deepseek-ai/dsh-gs-server'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import * as sensitivePolicy from '../src/index.ts'
import {
  DEFAULT_EGRESS_TOOLS,
  SENSITIVE_PROVIDER_FORBIDDEN,
} from '../src/index.ts'

const testSignal = new AbortController().signal

/** A ClientConfig whose `providers` map marks `trusted` ids trusted and adds `ext-cloud` as external. */
function gsClientConfig(trusted: readonly string[]): GsClientConfig {
  const providers: Record<string, GsModelProviderEntry> = {
    'ext-cloud': { api: 'openai-completions', models: [{ id: 'm1' }], trustLevel: 'external' },
  }
  for (const id of trusted) {
    providers[id] = { api: 'openai-completions', models: [{ id: 'm1' }], trustLevel: 'trusted' }
  }
  return {
    version: 1,
    agent: { sandboxProfile: 'workspace-write', approvalPolicy: 'policy-auto', dataClass: 'internal' },
    features: { customModel: false },
    settingsPages: {},
    permissions: { allowSubmit: true, allowExternalSkillInstall: false },
    skills: {},
    models: { providers },
    appUpdate: null,
    notice: null,
  }
}

/** Mutable ClientConfig holder the mock gsServer reads per call. */
interface ConfigHolder {
  current: GsClientConfig | undefined
}

/** Minimal gsServer service double backed by a mutable config holder. */
function mockGsServer(holder: ConfigHolder) {
  return {
    getAccessToken: () => Promise.resolve('test-token'),
    fetch: () => Promise.resolve(new Response()),
    getClientConfig: () => holder.current,
  }
}

/** One fake agent plus its scope key, cancel spy, and scope disposer. */
async function fakeAgent(rootCtx: Context, id: string, parentSession?: SessionId,
  events: readonly (SessionEvent | { type: 'sensitive/policy'; data: sensitivePolicy.SensitivePolicyEvent })[] = []) {
  const sessionId = SessionId(id)
  const cancel = vi.fn<(cause: AgentCancelCause) => void>()
  const seed = events.map((event, index): SessionEvent => ({ ...event, seq: SessionSeq(index), time: 0 }))
  const base = {
    id: sessionId,
    session: Session.create(sessionId, seed.length === 0 ? undefined : seed, {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 0,
      isSeeded: false,
      ...(parentSession === undefined ? {} : { parentSession }),
    }),
    cancel: (cause: AgentCancelCause) => { cancel(cause) },
  }
  // The scoped context resolves services through the MINTING plugin's
  // dependency chain — the minter must inject what the scope reaches.
  let scope!: Scope
  await rootCtx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, base) },
    { inject: ['tools', 'systemPrompt'] }))
  const agent = Object.assign(base, { ctx: scope.ctx }) as Agent & typeof base
  return { agent, cancel, key: base, scope }
}

/** Boot the tool pipeline, a mocked gsServer, and the plugin under test. */
async function setup(config?: sensitivePolicy.Config, trusted: readonly string[] = ['trusted-gw']) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Projections)
  const holder: ConfigHolder = { current: gsClientConfig(trusted) }
  ctx.provide('gsServer', mockGsServer(holder))
  const fiber = await ctx.plugin(sensitivePolicy, config)
  return { ctx, holder, fiber }
}

/** Register the egress + non-egress fixture tools the cases share. */
function registerFixtureTools(ctx: Context): void {
  ctx.tools.register(defineContentToolFixture({
    name: 'web_fetch', description: 'fetches a URL', parameters: {},
    async execute() { return [{ type: 'text' as const, text: 'fetched' }] },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'notes_query', description: 'reads local notes', parameters: {},
    async execute() { return [{ type: 'text' as const, text: 'notes' }] },
  }))
}

/** Run one tool call as one fake agent. */
function executeAs(ctx: Context, agent: Agent, name: string) {
  return ctx.tools.execute({ callId: ToolCallId(`c-${name}`), name, arguments: {}, signal: testSignal, agent })
}

/** One model request for one session on one provider route. */
function requestFor(sessionId: string, provider: string): GenerateOptions {
  return { provider, model: 'm1', messages: [], sessionId: SessionId(sessionId) }
}

/** Dispatch the real `llm/stream` waterfall; `terminal` plays the adapter. */
function stream(
  ctx: Context,
  options: GenerateOptions,
  terminal: (options: GenerateOptions) => AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  return ctx.waterfall('llm/stream', options, () => terminal(options))
}

/** Collect every chunk of one stream. */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('sensitive-policy egress tool denial', () => {
  it('flushes privacy before inference and restores it from actual Session events', async () => {
    const { ctx } = await setup()
    const { ctx: restored } = await setup()
    onTestFinished(async () => { await ctx.fiber.dispose(); await restored.fiber.dispose() })
    const { agent } = await fakeAgent(ctx, 'durable')
    Object.assign(agent, { session: Session.create(agent.id) })
    await ctx.serial('agent/created', { agent, source: 'startup' })
    let release!: () => void
    let started!: () => void
    const checkpoint = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    ctx.on('session/flush', async () => { started(); await checkpoint })
    const adapter = vi.fn(() => (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    const pending = drain(stream(ctx, requestFor('durable', 'trusted-gw'), adapter))
    onTestFinished(async () => { release(); await pending })
    await entered
    expect(adapter).not.toHaveBeenCalled()
    release()
    await pending
    expect(adapter).toHaveBeenCalledTimes(1)
    const { agent: recovered } = await fakeAgent(restored, 'durable', undefined, agent.session.snapshotEvents())
    await restored.serial('agent/created', { agent: recovered, source: 'startup' })
    const external = vi.fn(() => (async function* (): AsyncGenerator<StreamChunk> {})())
    const chunks = await drain(stream(restored, requestFor('durable', 'ext-cloud'), external))
    expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error' } }])
    expect(external).not.toHaveBeenCalled()
  })

  it('denies external MCP execution for endpoint-private sessions', async () => {
    const { ctx } = await setup()
    onTestFinished(() => ctx.fiber.dispose())
    const execute = vi.fn(async () => [{ type: 'text' as const, text: 'external' }])
    ctx.tools.register(defineContentToolFixture({ name: 'mcp__external__upload', description: 'fixture', parameters: {}, execute }))
    const { agent } = await fakeAgent(ctx, 'private-mcp')
    ctx.sensitivePolicy.enterPrivate('private-mcp', 'provider-endpoint')
    expect((await executeAs(ctx, agent, 'mcp__external__upload')).isError).toBe(true)
    expect(execute).not.toHaveBeenCalled()
    ctx.sensitivePolicy.enterPrivate('private-mcp')
    expect(ctx.sensitivePolicy.stateOf('private-mcp').privateCause).toBe('explicit')
  })
  it('denies a configured egress tool inside an explicitly private session, at the executor', async () => {
    const { ctx } = await setup()
    registerFixtureTools(ctx)
    const { agent } = await fakeAgent(ctx, 's1')
    ctx.sensitivePolicy.enterPrivate('s1')
    const result = await executeAs(ctx, agent, 'web_fetch')
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
    const text = result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('private session')
    expect(text).toContain('web_fetch')
  })

  it('keeps non-egress tools callable inside a private session', async () => {
    const { ctx } = await setup()
    registerFixtureTools(ctx)
    const { agent } = await fakeAgent(ctx, 's1')
    ctx.sensitivePolicy.enterPrivate('s1')
    const result = await executeAs(ctx, agent, 'notes_query')
    expect(result.isError).toBe(false)
  })

  it('keeps egress tools callable in standard sessions', async () => {
    const { ctx } = await setup()
    registerFixtureTools(ctx)
    const { agent } = await fakeAgent(ctx, 's2')
    const result = await executeAs(ctx, agent, 'web_fetch')
    expect(result.isError).toBe(false)
  })

  it('denies egress tools even when another pre-execute listener would allow them (monotonic guard)', async () => {
    const { ctx } = await setup()
    registerFixtureTools(ctx)
    const { agent } = await fakeAgent(ctx, 's1')
    ctx.on('tools/pre-execute', (_exec, _next) => Promise.resolve({ kind: 'allow' } as const))
    ctx.sensitivePolicy.enterPrivate('s1')
    const result = await executeAs(ctx, agent, 'web_fetch')
    expect(result.isError).toBe(true)
  })

  it('honors a configured egress list instead of the default', async () => {
    const { ctx } = await setup({ egressTools: ['web_fetch'] })
    registerFixtureTools(ctx)
    ctx.tools.register(defineContentToolFixture({
      name: 'web_search', description: 'searches the web', parameters: {},
      async execute() { return [{ type: 'text' as const, text: 'searched' }] },
    }))
    const { agent } = await fakeAgent(ctx, 's1')
    ctx.sensitivePolicy.enterPrivate('s1')
    expect((await executeAs(ctx, agent, 'web_fetch')).isError).toBe(true)
    expect((await executeAs(ctx, agent, 'web_search')).isError).toBe(false)
  })

  it('removes egress tools from the private agent scope at agent/created', async () => {
    const { ctx } = await setup()
    registerFixtureTools(ctx)
    ctx.sensitivePolicy.enterPrivate('s1')
    const { agent, key } = await fakeAgent(ctx, 's1')
    await ctx.serial('agent/created', { agent, source: 'startup' as const })
    expect(ctx.tools.get('web_fetch', key)).toBeUndefined()
    expect(ctx.tools.get('notes_query', key)).toBeDefined()
    // The global surface is untouched: other sessions still see the tool.
    expect(ctx.tools.get('web_fetch')).toBeDefined()
  })

  it('restricts the egress surface when a live session turns private mid-flight', async () => {
    const { ctx } = await setup()
    registerFixtureTools(ctx)
    const { agent, key } = await fakeAgent(ctx, 's1')
    const registry = new Map([[agent.id as string, agent]])
    ctx.provide('agents', { get: (id: SessionId) => registry.get(id as string) })
    await ctx.serial('agent/created', { agent, source: 'startup' as const })
    expect(ctx.tools.get('web_fetch', key)).toBeDefined()
    ctx.sensitivePolicy.enterPrivate('s1')
    expect(ctx.tools.get('web_fetch', key)).toBeUndefined()
  })

  it('a forked child of a private parent is private from creation', async () => {
    const { ctx } = await setup()
    registerFixtureTools(ctx)
    ctx.sensitivePolicy.enterPrivate('p1')
    const { agent } = await fakeAgent(ctx, 'c1', SessionId('p1'))
    await ctx.serial('agent/created', { agent, source: 'startup' as const })
    expect(ctx.sensitivePolicy.isPrivate('c1')).toBe(true)
    const result = await executeAs(ctx, agent, 'web_fetch')
    expect(result.isError).toBe(true)
  })

  it('restores a private session from the previous gs-worker policy event', async () => {
    const { ctx } = await setup()
    registerFixtureTools(ctx)
    const { agent, key } = await fakeAgent(ctx, 'legacy', undefined, [
      { type: 'sensitive/policy', data: { kind: 'enter-private', cause: 'explicit' } },
      { type: 'sensitive/policy', data: { kind: 'mark-sensitive' } },
    ])
    expect(ctx.sensitivePolicy.knows('legacy')).toBe(false)
    expect(sensitivePolicy.replaySensitivePolicyEvents(agent.session.snapshotEvents()
      .filter(event => event.type === 'sensitive/policy').map(event => event.data as never)).inferencePolicy).toBe('trusted-only')
    await ctx.serial('agent/created', { agent, source: 'startup' as const })
    expect(ctx.sensitivePolicy.knows('legacy')).toBe(true)
    expect(ctx.sensitivePolicy.isPrivate('legacy')).toBe(true)
    expect(ctx.sensitivePolicy.stateOf('legacy').sensitivity).toBe('sensitive')
    expect(ctx.tools.get('web_fetch', key)).toBeUndefined()
  })

  it('restores durable privacy even after a provisional standard registration', async () => {
    const { ctx } = await setup()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.sensitivePolicy.registerSession('pre-registered')
    const { agent } = await fakeAgent(ctx, 'pre-registered', undefined, [
      { type: 'sensitive/policy', data: { kind: 'enter-private', cause: 'explicit' } },
      { type: 'sensitive/policy', data: { kind: 'mark-sensitive' } },
    ])
    onTestFinished(() => agent.ctx.fiber.dispose())
    await ctx.serial('agent/created', { agent, source: 'startup' })
    expect(ctx.sensitivePolicy.stateOf('pre-registered')).toMatchObject({
      inferencePolicy: 'trusted-only', sensitivity: 'sensitive', privateCause: 'explicit',
    })
  })
})

describe('sensitive-policy audit header judgement', () => {
  it('a private session request on a trusted route dispatches with the session judged private', async () => {
    const { ctx } = await setup()
    ctx.sensitivePolicy.enterPrivate('s1')
    // The gateway proxy re-judges the request's session against this view at
    // forward time, so a private-at-dispatch request is the audit-header case.
    let privateAtDispatch: boolean | undefined
    await drain(stream(ctx, requestFor('s1', 'trusted-gw'), () => {
      privateAtDispatch = ctx.sensitivePolicy.isPrivate('s1')
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }))
    expect(privateAtDispatch).toBe(true)
    expect(ctx.sensitivePolicy.stateOf('s1').provider).toBe('trusted-gw')
  })

  it('a standard session request on an external route dispatches unjudged', async () => {
    const { ctx } = await setup()
    let privateAtDispatch: boolean | undefined
    await drain(stream(ctx, requestFor('s3', 'ext-cloud'), () => {
      privateAtDispatch = ctx.sensitivePolicy.isPrivate('s3')
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }))
    expect(privateAtDispatch).toBe(false)
    expect(ctx.sensitivePolicy.isPrivate('s3')).toBe(false)
  })

  it('leaves requests without a session identity untouched', async () => {
    const { ctx } = await setup()
    ctx.sensitivePolicy.enterPrivate('s1')
    let reached = false
    const options: GenerateOptions = { provider: 'ext-cloud', model: 'm1', messages: [] }
    await drain(stream(ctx, options, () => {
      reached = true
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }))
    expect(reached).toBe(true)
    expect(ctx.sensitivePolicy.knows('undefined')).toBe(false)
  })
})

describe('sensitive-policy trusted-route enforcement', () => {
  it('refuses a private session request on an untrusted route with session_provider_forbidden', async () => {
    const { ctx } = await setup()
    ctx.sensitivePolicy.enterPrivate('s1')
    let adapterCalled = false
    const chunks = await drain(stream(ctx, requestFor('s1', 'ext-cloud'), () => {
      adapterCalled = true
      return (async function* (): AsyncGenerator<StreamChunk> {})()
    }))
    expect(adapterCalled).toBe(false)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: SENSITIVE_PROVIDER_FORBIDDEN } },
    })
  })

  it('fails closed when no ClientConfig is cached', async () => {
    const { ctx, holder } = await setup()
    holder.current = undefined
    ctx.sensitivePolicy.enterPrivate('s1')
    let adapterCalled = false
    await drain(stream(ctx, requestFor('s1', 'trusted-gw'), () => {
      adapterCalled = true
      return (async function* (): AsyncGenerator<StreamChunk> {})()
    }))
    expect(adapterCalled).toBe(false)
  })

  it('locks egress when trusted-route traffic makes a session private', async () => {
    const { ctx } = await setup()
    registerFixtureTools(ctx)
    const { agent } = await fakeAgent(ctx, 's4')
    let privateAtDispatch: boolean | undefined
    await drain(stream(ctx, requestFor('s4', 'trusted-gw'), () => {
      privateAtDispatch = ctx.sensitivePolicy.isPrivate('s4')
      return (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }))
    // The judgement lands before dispatch, so the gateway audits this very request.
    expect(privateAtDispatch).toBe(true)
    const state = ctx.sensitivePolicy.stateOf('s4')
    expect(state.inferencePolicy).toBe('trusted-only')
    expect(state.privateCause).toBe('provider-endpoint')
    // The endpoint-judged tier keeps egress tools: its traffic stays inside the trusted boundary.
    expect((await executeAs(ctx, agent, 'web_fetch')).isError).toBe(true)
  })
})

describe('sensitive-policy suspension on trust loss', () => {
  /** Private session with observed trusted-route traffic plus a live agent. */
  async function privateSessionWithTraffic(ctx: Context, id: string) {
    ctx.sensitivePolicy.enterPrivate(id)
    await drain(stream(ctx, requestFor(id, 'trusted-gw'), () => (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()))
    const { agent, cancel } = await fakeAgent(ctx, id)
    return { agent, cancel }
  }

  function provideAgents(ctx: Context, entries: readonly Agent[]): void {
    const registry = new Map(entries.map(agent => [agent.id as string, agent]))
    ctx.provide('agents', { get: (id: SessionId) => registry.get(id as string) })
  }

  it('suspends private sessions with observed traffic when trust is revoked', async () => {
    const { ctx } = await setup()
    const victim = await privateSessionWithTraffic(ctx, 's1')
    // A private session without observed provider traffic has nothing to suspend yet.
    ctx.sensitivePolicy.enterPrivate('s9')
    const quiet = await fakeAgent(ctx, 's9')
    provideAgents(ctx, [victim.agent, quiet.agent])
    ctx.emit('gs-server/trust-revoked')
    expect(victim.cancel).toHaveBeenCalledOnce()
    const cause = victim.cancel.mock.calls[0]?.[0]
    if (cause?.kind !== 'hook') throw new Error('expected a hook-cause cancellation')
    expect(cause.reason).toContain('trust revoked')
    expect(quiet.cancel).not.toHaveBeenCalled()
  })

  it('suspends a private session whose provider leaves the trusted set on client-config change', async () => {
    const { ctx } = await setup()
    const victim = await privateSessionWithTraffic(ctx, 's1')
    const bystander = await privateSessionWithTraffic(ctx, 's2')
    // s2 rides a provider that stays trusted.
    ctx.sensitivePolicy.noteProvider('s2', 'other-gw')
    provideAgents(ctx, [victim.agent, bystander.agent])
    ctx.emit('gs-server/client-config-changed', gsClientConfig(['other-gw']))
    expect(victim.cancel).toHaveBeenCalledOnce()
    expect(bystander.cancel).not.toHaveBeenCalled()
  })
})

describe('sensitive-policy gated skill lane mounting', () => {
  /** Spy-backed `gsServerSkillGate` service double, matching the gs-server-skills contract. */
  function provideGate(ctx: Context) {
    const mountPrivateLane = vi.fn<(scope: Context) => void>()
    ctx.provide('gsServerSkillGate', { mountPrivateLane })
    return mountPrivateLane
  }

  /** Register a live-agent registry resolving the given agents by session id. */
  function provideAgents(ctx: Context, entries: readonly Agent[]): void {
    const registry = new Map(entries.map(agent => [agent.id as string, agent]))
    ctx.provide('agents', { get: (id: SessionId) => registry.get(id as string) })
  }

  it('mounts the lane when an agent is created for an already-private session', async () => {
    const { ctx } = await setup()
    const mountPrivateLane = provideGate(ctx)
    ctx.sensitivePolicy.enterPrivate('s1')
    const { agent } = await fakeAgent(ctx, 's1')
    await ctx.serial('agent/created', { agent, source: 'startup' as const })
    expect(mountPrivateLane).toHaveBeenCalledOnce()
    expect(mountPrivateLane).toHaveBeenCalledWith(agent.ctx)
  })

  it('warns and retries on a later transition when the gate mount throws', async () => {
    const { ctx } = await setup()
    const mountPrivateLane = vi.fn<(scope: Context) => void>()
      .mockImplementationOnce(() => { throw new Error('lane boom') })
    ctx.provide('gsServerSkillGate', { mountPrivateLane })
    ctx.sensitivePolicy.enterPrivate('s1')
    const { agent } = await fakeAgent(ctx, 's1')
    provideAgents(ctx, [agent])
    await ctx.serial('agent/created', { agent, source: 'startup' as const })
    expect(mountPrivateLane).toHaveBeenCalledOnce()
    // The failed mount never marked the session, so the next transition retries.
    ctx.sensitivePolicy.markPotential('s1')
    expect(mountPrivateLane).toHaveBeenCalledTimes(2)
  })

  it('mounts the lane on the live agent when trusted-route traffic turns the session private mid-flight', async () => {
    const { ctx } = await setup()
    const mountPrivateLane = provideGate(ctx)
    const { agent } = await fakeAgent(ctx, 's6')
    provideAgents(ctx, [agent])
    await ctx.serial('agent/created', { agent, source: 'startup' as const })
    expect(mountPrivateLane).not.toHaveBeenCalled()
    await drain(stream(ctx, requestFor('s6', 'trusted-gw'), () => (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()))
    expect(ctx.sensitivePolicy.stateOf('s6').privateCause).toBe('provider-endpoint')
    expect(mountPrivateLane).toHaveBeenCalledOnce()
    expect(mountPrivateLane).toHaveBeenCalledWith(agent.ctx)
  })

  it('mounts the lane on the live agent when the session is entered explicitly mid-flight', async () => {
    const { ctx } = await setup()
    const mountPrivateLane = provideGate(ctx)
    const { agent } = await fakeAgent(ctx, 's7')
    provideAgents(ctx, [agent])
    await ctx.serial('agent/created', { agent, source: 'startup' as const })
    expect(mountPrivateLane).not.toHaveBeenCalled()
    ctx.sensitivePolicy.enterPrivate('s7')
    expect(mountPrivateLane).toHaveBeenCalledOnce()
    expect(mountPrivateLane).toHaveBeenCalledWith(agent.ctx)
  })

  it('is a no-op without the gate service, and a late-composed gate joins on the next transition', async () => {
    const { ctx } = await setup()
    ctx.sensitivePolicy.enterPrivate('s1')
    const { agent } = await fakeAgent(ctx, 's1')
    // No gate composed: creation of a private session's agent must not fail.
    await ctx.serial('agent/created', { agent, source: 'startup' as const })
    expect(ctx.get('gsServerSkillGate')).toBeUndefined()
    const mountPrivateLane = provideGate(ctx)
    provideAgents(ctx, [agent])
    ctx.sensitivePolicy.markSensitive('s1')
    expect(mountPrivateLane).toHaveBeenCalledOnce()
    expect(mountPrivateLane).toHaveBeenCalledWith(agent.ctx)
  })

  it('mounts at most once per session across creation and later transitions', async () => {
    const { ctx } = await setup()
    const mountPrivateLane = provideGate(ctx)
    ctx.sensitivePolicy.enterPrivate('s1')
    const { agent } = await fakeAgent(ctx, 's1')
    provideAgents(ctx, [agent])
    await ctx.serial('agent/created', { agent, source: 'startup' as const })
    ctx.sensitivePolicy.markPotential('s1')
    ctx.sensitivePolicy.markSensitive('s1')
    expect(mountPrivateLane).toHaveBeenCalledOnce()
  })

  it('remounts the lane when a disposed private agent is recreated', async () => {
    const { ctx } = await setup()
    const mountPrivateLane = provideGate(ctx)
    ctx.sensitivePolicy.enterPrivate('s1')
    const first = await fakeAgent(ctx, 's1')
    await ctx.serial('agent/created', { agent: first.agent, source: 'startup' as const })
    ctx.emit('agent/disposed', { agent: first.agent })
    const second = await fakeAgent(ctx, 's1')
    await ctx.serial('agent/created', { agent: second.agent, source: 'startup' as const })
    expect(mountPrivateLane).toHaveBeenCalledTimes(2)
    expect(mountPrivateLane).toHaveBeenLastCalledWith(second.agent.ctx)
  })
})

describe('sensitive-policy contract', () => {
  it('has no default export and keeps name/inject through unwrapExports', () => {
    expect('default' in sensitivePolicy).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(sensitivePolicy) as Record<string, unknown>
    expect(unwrapped).toBe(sensitivePolicy)
    expect(unwrapped.name).toBe('sensitive-policy')
    expect(unwrapped.inject).toEqual(['gsServer', 'tools', 'sessionProjections'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('exports the default egress list and the policy failure code', () => {
    expect(DEFAULT_EGRESS_TOOLS).toContain('web_fetch')
    expect(SENSITIVE_PROVIDER_FORBIDDEN).toBe('session_provider_forbidden')
  })
})

describe('sensitive-policy disposal (HMR safety)', () => {
  it('removes the guard, the llm/stream wrapper, and the service when the fiber disposes', async () => {
    const { ctx, fiber } = await setup()
    registerFixtureTools(ctx)
    const core = ctx.sensitivePolicy
    const { agent } = await fakeAgent(ctx, 's1')
    core.enterPrivate('s1')
    expect((await executeAs(ctx, agent, 'web_fetch')).isError).toBe(true)
    await fiber.dispose()
    expect((await executeAs(ctx, agent, 'web_fetch')).isError).toBe(false)
    const options = requestFor('s1', 'trusted-gw')
    await drain(ctx.waterfall('llm/stream', options, () => (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()))
    expect(ctx.get('sensitivePolicy')).toBeUndefined()
  })
})
