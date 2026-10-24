/**
 * Sensitive-data compliance guard plugin (国盛证券办公 Agent 私密会话合规).
 *
 * A session is private (`inferencePolicy: 'trusted-only'`) when entered
 * explicitly through the `sensitivePolicy` service, inherited from a private
 * fork parent, or judged by endpoint: a session whose model request or
 * effective model selection resolves to a server-trusted provider route is a
 * private conversation (`privateCause: 'provider-endpoint'`). The selection
 * judgement lands at agent activation and at each `model/selection` commit —
 * before the next request assembles — while the request judgement stands at
 * the call boundary. Endpoint-judged privacy is re-judged at each selection
 * commit and activation: while the session has observed no model traffic and
 * carries no sensitivity marking, switching off the trusted route releases it
 * back to standard (see `SensitivePolicyCore.exitEndpointPrivacy`).
 * Enforcement lives in the operations
 * that make it, never in UI filtering:
 *
 * - `llm/stream` wrapper: a private session's request on an untrusted route
 *   short-circuits to a `session_provider_forbidden` error finish; every
 *   allowed request records its provider route, and the gsclaw model-gateway
 *   proxy (`@deepseek-ai/dsh-llm-gs-gateway`) re-judges the session against
 *   this core to emit the `x-gsclaw-sensitive: 1` audit header on the wire.
 * - `tools.guard` (monotonic, evaluated after every `tools/pre-execute`
 *   listener): private sessions lose the configured egress-capable
 *   tools at the execution gate, and `agent/created` also restricts them off
 *   the session's visible surface. External MCP denial is configured independently.
 * - `gsServerSkillGate.mountPrivateLane` (optional, provided by
 *   `@deepseek-ai/dsh-gs-server-skills`): every private session's agent —
 *   however it became private — gets the gated trusted-only server-skill lane
 *   mounted into its scoped context, at `agent/created` or mid-flight when a
 *   live session turns private. Absence of the gate is a no-op.
 * - `gs-server/trust-revoked` fails closed: every private session with
 *   observed model traffic is judged suspended and its live agent is
 *   cancelled; `gs-server/client-config-changed` re-judges each private
 *   session's provider against the fresh trust metadata.
 *
 * @module @deepseek-ai/dsh-sensitive-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { GsClientConfig } from '@deepseek-ai/dsh-gs-server'
// Type-only: pulls the `Context.tools` service and guard-signature declarations in.
import type {} from '@deepseek-ai/dsh-tools'
import { applySensitivePolicyEvent, STANDARD_SESSION_STATE, SensitivePolicyCore } from './core.ts'
import type { GsServerSkillGateFace, SensitivePolicyEvent, SensitivePolicyProjectionState } from './types.ts'
import {
  SENSITIVE_PROVIDER_FORBIDDEN,
  isTrustedProvider,
} from './trust.ts'

export {
  applySensitivePolicyEvent,
  replaySensitivePolicyEvents,
  SensitivePolicyCore,
  STANDARD_SESSION_STATE,
} from './core.ts'
export type { SensitivePolicyView } from './core.ts'
export {
  GS_SENSITIVE_SESSION_HEADER,
  GS_SENSITIVE_SESSION_HEADER_VALUE,
  SENSITIVE_PROVIDER_FORBIDDEN,
  isTrustedProvider,
  resolveProviderTrust,
} from './trust.ts'
export type { GsProviderTrustLevel } from './trust.ts'
export type {
  GsServerSkillGateFace,
  SensitiveInferencePolicy,
  SensitivePolicyEvent,
  SensitivePrivateCause,
  SensitiveSessionState,
  SessionSensitivity,
} from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'sensitive-policy'

/** The gs-server client (trust source) and the tool registry this plugin guards through. */
export const inject = ['gsServer', 'tools', 'sessionProjections']

const policyProjection = {
  key: 'sensitive.policy',
  stateVersion: 1,
  stateSchema: zod.object({
    policy: zod.object({
      inferencePolicy: zod.enum(['standard', 'trusted-only']),
      sensitivity: zod.enum(['unclassified', 'potential', 'sensitive']),
      privateCause: zod.enum(['explicit', 'provider-endpoint']).optional(),
      provider: zod.string().optional(),
    }).strict(),
    hasTransitions: zod.boolean(),
  }).strict().transform(({ policy, hasTransitions }): SensitivePolicyProjectionState => ({
    policy: {
      inferencePolicy: policy.inferencePolicy,
      sensitivity: policy.sensitivity,
      ...(policy.privateCause === undefined ? {} : { privateCause: policy.privateCause }),
      ...(policy.provider === undefined ? {} : { provider: policy.provider }),
    },
    hasTransitions,
  })),
  init: (): SensitivePolicyProjectionState => ({ policy: STANDARD_SESSION_STATE, hasTransitions: false }),
  apply: (state, event) => event.type === 'sensitive/policy'
    ? { policy: applySensitivePolicyEvent(state.policy, event.data), hasTransitions: true }
    : state,
} satisfies ProjectionDefinition<'sensitive.policy', SensitivePolicyProjectionState>

/**
 * Egress-capable tools every private session loses by default.
 * `run_code` is a reserved presentation transport `tools.restrict` cannot
 * name; the guard denies the end-capability tools it would reach, which is
 * the supported cover. Deployments change the list through {@link Config}.
 */
export const DEFAULT_EGRESS_TOOLS: string[] = [
  'bash',
  'pwsh',
  'web_fetch',
  'web_search',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'cordis_inspect_self',
  'cordis_define',
  'cordis_run',
  'cordis_stop',
  'cordis_undefine',
]

/**
 * Plugin config, validated by the same-named schemastery schema.
 */
export interface Config {
  /** Whether private sessions deny external MCP tools; defaults to true. */
  restrictExternalMcp?: boolean
  /**
   * Egress-capable tool names denied to private sessions (default
   * {@link DEFAULT_EGRESS_TOOLS}). Entries are resolved against the live
   * registry at restriction time, so naming a tool no composition registered
   * is valid. An empty list removes configured-tool denial; external MCP
   * denial (unless restrictExternalMcp is false), trusted-route enforcement, and audit marking remain active.
   */
  egressTools?: string[]
}

/** Runtime schema for {@link Config}. */
export const Config: z<Config> = z.object({
  restrictExternalMcp: z.boolean().default(true),
  egressTools: z.array(z.string()).default([...DEFAULT_EGRESS_TOOLS]),
})

/** The config after default materialization (direct construction bypasses the Loader schema). */
interface ResolvedConfig {
  readonly egressTools: readonly string[]
  readonly restrictExternalMcp: boolean
}

/**
 * Materialize defaults for a caller that mounted the plugin without the
 * Loader's schema pass.
 * @param config - the raw plugin config, when supplied.
 * @returns the complete effective config.
 */
function resolveConfig(config?: Config): ResolvedConfig {
  return {
    egressTools: config?.egressTools ?? [...DEFAULT_EGRESS_TOOLS],
    restrictExternalMcp: config?.restrictExternalMcp ?? true,
  }
}

/**
 * The refusal a private session's request on an untrusted route short-circuits
 * to: one terminal error chunk, the same shape an adapter failure normalizes
 * into, so the loop logs and routes it through its ordinary failure path.
 * @param options - the refused request (its provider names the untrusted route).
 * @returns a one-chunk stream ending in the `session_provider_forbidden` error.
 */
function providerForbiddenStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
  const failure = {
    message: `private session cannot use untrusted provider route "${options.provider}"; select a trusted model route for sensitive conversations`,
    code: SENSITIVE_PROVIDER_FORBIDDEN as string,
  }
  // oxlint-disable-next-line typescript/require-await -- the stream contract requires AsyncIterable; a sync generator cannot satisfy it
  return (async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure } }
  })()
}

/** Provider route of one `model/selection`-shaped value, when it carries one. */
function providerOfSelectionValue(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const provider = (value as { provider?: unknown }).provider
  return typeof provider === 'string' && provider !== '' ? provider : undefined
}

/**
 * Effective provider route of one `modelSelection` projection state: the
 * pending selection first, then the last used one. The projection is registered
 * by the Session Controller package; its state is read loosely here and
 * narrowed field by field so this plugin composes without it.
 */
function providerOfSelectionState(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null) return undefined
  const record = state as { pending?: unknown; lastUsed?: unknown }
  return providerOfSelectionValue(record.pending) ?? providerOfSelectionValue(record.lastUsed)
}

/** Narrow optional face of the composition's default-model service. */
interface AgentDefaultModelFace {
  currentSelection(): { provider: string }
}

/**
 * Register the policy core service and every enforcement listener.
 * @param ctx - the plugin context; `gsServer` (trust source) is a declared
 *   injection, while `agents` and the optional `gsServerSkillGate` (the
 *   gs-server-skills plugin may not be composed) are resolved lazily so the
 *   composition may load in any order.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = resolveConfig(config)
  const core = new SensitivePolicyCore()
  ctx.provide('sensitivePolicy', core)
  ctx.sessionProjections.register(policyProjection)
  const egressTools = new Set(resolved.egressTools)
  const liveSessions = new Map<string, Session>()
  const durability = new Map<string, Promise<void>>()

  /**
   * Persist one committed transition, then flush. The append runs deferred on
   * the durability chain: a transition can commit while another append is
   * being published (`enter-private` from the `model/selection` commit
   * listener re-enters this subscriber), and `Session.append` refuses
   * reentrant publication. Chaining preserves transition order, and the
   * `llm/stream` wrapper awaits the chain before dispatching, so persistence
   * still lands before the next sensitive operation. Failures reject the
   * chain: they surface at that await and are logged here.
   */
  const recordTransition = (sessionId: string, event: SensitivePolicyEvent): void => {
    const pending = (durability.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        const session = liveSessions.get(sessionId) ?? ctx.get('sessions')?.get(SessionId(sessionId))
        if (session === undefined) return
        session.append('sensitive/policy', event)
        const store = ctx.get('sessions')
        if (store === undefined) { await ctx.parallel('session/flush', session); return }
        if (!await store.flush(session)) throw new Error('sensitive-policy requires a durable Session backend')
      })
    durability.set(sessionId, pending)
    void pending.catch((cause: unknown) => { ctx.logger.error(cause) })
  }
  ctx.effect(() => core.subscribe(recordTransition), 'sensitive-policy: durable policy transitions')

  const agents = (): AgentRegistry | undefined => ctx.get('agents')
  const currentClientConfig = (): GsClientConfig | undefined => ctx.gsServer.getClientConfig()
  core.trustsProvider = provider => isTrustedProvider(currentClientConfig(), provider)

  /**
   * Effective provider route of one session: the pending selection, the last
   * used one, then the composition default. The `modelSelection` projection
   * belongs to the Session Controller package, so its state is read through a
   * loose key-accepting face and narrowed field by field; both it and the
   * default-model service may be absent from a composition.
   */
  const effectiveProviderOf = (session: Session): string | undefined => {
    const projections = ctx.sessionProjections as unknown as { stateOf(session: Session, key: string): unknown }
    const selected = providerOfSelectionState(projections.stateOf(session, 'modelSelection'))
    if (selected !== undefined) return selected
    const defaults = ctx.get('agentDefaultModel') as AgentDefaultModelFace | undefined
    return defaults?.currentSelection().provider
  }

  // Trusted-route enforcement and audit marking at the model-call boundary.
  ctx.on('llm/stream', (options, next) => {
    const sessionId = options.sessionId
    if (sessionId === undefined) return next()
    const key = String(sessionId)
    core.registerSession(key)
    const trusted = isTrustedProvider(currentClientConfig(), options.provider)
    // Endpoint judgement: traffic already on a trusted route makes the
    // conversation private with the same egress restrictions as explicit entry.
    if (!core.isPrivate(key) && trusted) core.enterPrivate(key, 'provider-endpoint')
    if (!core.isPrivate(key)) return next()
    if (!trusted) {
      ctx.logger.warn(`sensitive-policy: denied model request of private session ${key} on untrusted provider route "${options.provider}"`)
      return providerForbiddenStream(options)
    }
    core.noteProvider(key, options.provider)
    return (async function* () {
      await durability.get(key)
      yield* next()
    })()
  })

  // Monotonic egress denial at the execution gate: no listener ordering can
  // turn this refusal back into permission, and PTC sub-dispatches traverse
  // the same gate.
  ctx.effect(() => ctx.tools.guard((exec) => {
    const agent = exec.agent
    if (agent === undefined || (!egressTools.has(exec.name) && !(resolved.restrictExternalMcp && exec.name.startsWith('mcp__')))) {
      return undefined
    }
    const state = core.stateOf(String(agent.session.id))
    if (state.inferencePolicy !== 'trusted-only') return undefined
    return `tool "${exec.name}" is unavailable in a private session: sensitive-data policy restricts egress-capable tools`
  }), 'sensitive-policy: private-session egress guard')
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent !== undefined && core.isPrivate(String(exec.agent.session.id))) {
      await durability.get(String(exec.agent.session.id))
    }
    return next()
  })

  /**
   * Lift the egress tools off one private session's visible surface (the
   * guard above remains the enforcement). Scoped restrictions unwind with the
   * agent; registration races are idempotent per session. The disposer is
   * kept so {@link liftEgress} can restore the surface when endpoint-judged
   * privacy is released before any traffic.
   */
  const restrictedSessions = new Map<string, () => void>()
  const restrictEgress = (agent: Agent): void => {
    const sessionId = String(agent.session.id)
    if (restrictedSessions.has(sessionId)) return
    const denied = resolved.egressTools.filter(tool => ctx.tools.get(tool) !== undefined)
    if (denied.length === 0) return
    try {
      restrictedSessions.set(sessionId, agent.ctx.tools.restrict({ deny: [...denied] }))
    } catch (cause) {
      ctx.logger.warn(`sensitive-policy: private session ${sessionId} egress visibility restriction failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /**
   * Restore one session's egress tool surface after endpoint-judged privacy
   * is released. The execution gate reads live policy state, so only the
   * visibility restriction needs lifting; the mounted skill lane re-checks
   * `isPrivate` per load and neutralizes itself.
   * @param sessionId - the released session id.
   */
  const liftEgress = (sessionId: string): void => {
    const lift = restrictedSessions.get(sessionId)
    if (lift === undefined) return
    restrictedSessions.delete(sessionId)
    try {
      lift()
    } catch (cause) {
      ctx.logger.warn(`sensitive-policy: released session ${sessionId} egress visibility restore failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  /**
   * Mount the gated trusted-only server-skill lane into one private session's
   * agent scope (`agent.ctx`, the same scoped context `tools.restrict` above
   * is reached through). The gate is optional — the gs-server-skills plugin
   * may not be composed — and is resolved per attempt, so a gate composed
   * after the session turned private still joins on the next transition:
   * only a real mount marks the session, and the mark makes repeated triggers
   * (creation plus every later committed transition) a no-op. The lane's
   * scoped registration unwinds with the agent, so the trust-revocation
   * cancellation below tears it down without a dedicated disposer.
   */
  const laneMountedSessions = new Set<string>()
  const mountSkillLane = (agent: Agent): void => {
    const sessionId = String(agent.session.id)
    if (laneMountedSessions.has(sessionId)) return
    const gate = ctx.get('gsServerSkillGate') as GsServerSkillGateFace | undefined
    if (gate === undefined) return
    try {
      gate.mountPrivateLane(agent.ctx)
      laneMountedSessions.add(sessionId)
    } catch (cause) {
      ctx.logger.warn(`sensitive-policy: private session ${sessionId} skill lane mount failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    const sessionId = String(agent.session.id)
    liveSessions.set(sessionId, agent.session)
    const restored = ctx.sessionProjections.stateOf(agent.session, 'sensitive.policy')
    if (restored === undefined) throw new Error('sensitive policy projection is required before Agent creation')
    core.registerSession(sessionId, restored.policy)
    if (core.isPrivate(sessionId) && !restored.hasTransitions) {
      const state = core.stateOf(sessionId)
      recordTransition(sessionId, { kind: 'enter-private', cause: state.privateCause ?? 'explicit' })
      if (state.sensitivity === 'sensitive') recordTransition(sessionId, { kind: 'mark-sensitive' })
      else if (state.sensitivity === 'potential') recordTransition(sessionId, { kind: 'mark-potential' })
      if (state.provider !== undefined) recordTransition(sessionId, { kind: 'use-provider', provider: state.provider })
    }
    // Private by lineage: a forked child of a private parent stays private.
    const parent = agent.session.header.parentSession
    if (parent !== undefined && core.isPrivate(String(parent))) core.enterPrivate(sessionId)
    // Endpoint judgement at activation: a session whose effective selection
    // resolves to a trusted route enters private before its first request
    // assembles, so the gated skill lane mounts ahead of prompt assembly. A
    // restored endpoint-private session is re-judged against the same
    // selection: while it has observed no traffic, a current untrusted route
    // releases it before the lane and restrictions apply.
    const effectiveProvider = effectiveProviderOf(agent.session)
    if (!core.isPrivate(sessionId)) {
      if (effectiveProvider !== undefined && core.trustsProvider(effectiveProvider)) core.enterPrivate(sessionId, 'provider-endpoint')
    } else if (effectiveProvider !== undefined && !core.trustsProvider(effectiveProvider)) {
      core.exitEndpointPrivacy(sessionId)
    }
    if (core.isPrivate(sessionId)) {
      // The gated skill lane joins every private session, however it became
      // private; every cause applies the egress restrictions.
      mountSkillLane(agent)
      restrictEgress(agent)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    liveSessions.delete(String(agent.session.id))
    restrictedSessions.delete(String(agent.session.id))
    laneMountedSessions.delete(String(agent.session.id))
  })
  // Endpoint judgement at selection commit: switching a session onto a trusted
  // route enters private at once — a live agent mounts the gated lane before
  // the next request assembles, and a draft session is already private when
  // its agent activates. The judgement reruns in both directions: switching to
  // an untrusted route releases endpoint-judged privacy that has observed no
  // traffic, restoring the live agent's egress surface.
  ctx.on('session/event', (session, event) => {
    if ((event as { type: string }).type !== 'model/selection') return
    const provider = providerOfSelectionValue((event as { data?: unknown }).data)
    if (provider === undefined) return
    const sessionId = String(session.id)
    core.registerSession(sessionId)
    if (core.trustsProvider(provider)) {
      core.enterPrivate(sessionId, 'provider-endpoint')
      return
    }
    if (core.exitEndpointPrivacy(sessionId)) liftEgress(sessionId)
  })
  // A session that turns private mid-flight mounts the lane on its live agent
  // too, not only at creation, and restricts the egress surface.
  ctx.effect(() => core.subscribe((sessionId) => {
    if (!core.isPrivate(sessionId)) return
    const agent = agents()?.get(SessionId(sessionId))
    if (agent === undefined) return
    mountSkillLane(agent)
    restrictEgress(agent)
  }), 'sensitive-policy: policy transition subscription')

  /**
   * Judge suspensions; the live agent cancellation is the execution of the
   * judgement. Suspended sessions stay private, so their next request is
   * re-judged by the `llm/stream` wrapper above.
   */
  const suspendWhere = (isTrusted: (provider: string) => boolean, reason: string): void => {
    for (const sessionId of core.suspendedSessions(isTrusted)) {
      ctx.logger.warn(`sensitive-policy: private session ${sessionId} suspended: ${reason}`)
      agents()?.get(SessionId(sessionId))?.cancel({ kind: 'hook', reason })
    }
  }
  // Trust revocation fails closed: the cached config may predate the
  // revocation, so every private session with observed model traffic suspends.
  ctx.on('gs-server/trust-revoked', () => {
    suspendWhere(() => false, 'provider trust revoked for a private session')
  })
  ctx.on('gs-server/session-ended', () => {
    for (const session of liveSessions.values()) {
      agents()?.get(session.id)?.cancel({ kind: 'hook', reason: 'gsclaw-server session ended' })
    }
  })
  ctx.on('gs-server/client-config-changed', (config) => {
    suspendWhere(provider => isTrustedProvider(config, provider), 'provider trust changed for a private session')
  })
}
