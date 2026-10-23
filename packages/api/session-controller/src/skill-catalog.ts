/** Session-addressed, cold-readable skill catalog Remote. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-working-directory'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SkillListRequest, SkillListValue } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the Session-addressed `skills` Remote namespace. */
    sessionSkillCatalog: SessionSkillCatalog
  }
}

/**
 * Narrow optional face of the sensitive-policy service
 * (`@deepseek-ai/dsh-sensitive-policy`): privacy state plus the provider-trust
 * predicate behind the endpoint judgement. Absent service = no gated lane.
 */
interface SessionPrivacyFace {
  isPrivate(sessionId: string): boolean
  trustsProvider(provider: string): boolean
}

/**
 * Narrow optional face of the gs-server skill catalog share
 * (`@deepseek-ai/dsh-gs-server-skills`): the gated trusted-only entries of the
 * latest server sync, carrying their display metadata.
 */
interface GatedServerSkillCatalogFace {
  snapshot(): {
    gated: readonly {
      name: string
      displayName?: string
      description?: string
    }[]
  }
}

/** Host service backing `ctx.remote.skills` without activating a cold Agent. */
export class SessionSkillCatalog extends TypertRemoteService {
  static inject = ['agents', 'sessionQuery', 'typert', 'workingDirectory']

  /** @param ctx - Host context carrying Session reads and optional skill/preset services. */
  constructor(ctx: Context) {
    super(ctx, 'sessionSkillCatalog', { namespace: 'skills' })
  }

  /**
   * List the user-invocable skills visible to one Session composition.
   * Gated trusted-only server skills join the list when the Session is private
   * or its effective model selection already resolves to a trusted route, so
   * the composer can name them before the private Agent activates; loading and
   * execution keep their own private-session checks.
   * @param request - Session identity whose cwd and preset select the catalog view.
   * @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
   * @returns user-invocable skill metadata without loading skill bodies.
   * @throws RemoteError when the Session cannot be inspected or no registry can serve it.
   */
  @Remote
  async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> {
    const { sessionId } = request
    let cwd: string
    let agentPreset: string | undefined
    let selectedProvider: string | undefined
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      if (observation.projections === undefined) {
        throw new Error('skill catalog requires a projected Session observation')
      }
      cwd = observation.projections.values.workingDirectory
        ?? observation.header.cwd
        ?? this.ctx.workingDirectory.defaultDirectory
      agentPreset = observation.projections.values.agentPreset ?? undefined
      selectedProvider = observation.projections.values.modelSelection?.next?.provider ?? undefined
      const live = this.ctx.agents.get(sessionId)
      if (live !== undefined) cwd = await this.ctx.workingDirectory.ensure(live, signal)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new RemoteError('session/not-found', `session "${sessionId}" not found`, { sessionId })
      }
      throw new RemoteError(
        'gateway/internal',
        `session "${sessionId}" could not be inspected: ${String(error)}`,
        {},
      )
    }

    const live = this.ctx.agents.get(sessionId)
    const presets = this.ctx.get('agentPresets')
    const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
    const skillRegistry = scoped ?? this.ctx.get('skills')
    if (skillRegistry === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
        {},
      )
    }

    await using lease = live === undefined ? await this.scopeFor(agentPreset) : undefined
    const scope = live ?? lease?.key
    try {
      const skills = (await skillRegistry.list({ cwd, scope })).filter(isUserInvocable)
      const entries: SkillListValue['skills'] = skills.map(skill => ({
        name: skill.name,
        ...skill.path === undefined ? {} : { path: skill.path },
        description: skill.description,
        ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
        modelInvocable: skill.invocation.modelInvocable,
      }))
      return { skills: [...entries, ...this.gatedComposerSkills(String(sessionId), selectedProvider, entries)] }
    } catch (error: unknown) {
      throw new RemoteError('gateway/internal', `skill listing failed: ${String(error)}`, {})
    }
  }

  /**
   * Gated trusted-only server skills bound to become invocable in one Session:
   * listed when the Session is private or its effective selection (pending
   * choice, then the composition default) resolves to a trusted route. The
   * merge is listing-only — the gated lane's own per-load private check stays
   * the gate for bodies and executions.
   * @param sessionId - the Session whose composer reads the catalog.
   * @param selectedProvider - provider route of the Session's pending selection, when recorded.
   * @param listed - entries already listed through the registry.
   * @returns gated entries not already listed, or none when the lane stays closed.
   */
  private gatedComposerSkills(
    sessionId: string,
    selectedProvider: string | undefined,
    listed: SkillListValue['skills'],
  ): SkillListValue['skills'] {
    const policy = this.ctx.get('sensitivePolicy') as SessionPrivacyFace | undefined
    const catalog = this.ctx.get('gsServerSkillCatalog') as GatedServerSkillCatalogFace | undefined
    if (policy === undefined || catalog === undefined) return []
    const provider = selectedProvider ?? this.ctx.agentDefaultModel.currentSelection().provider
    if (!policy.isPrivate(sessionId) && !policy.trustsProvider(provider)) return []
    const seen = new Set(listed.map(skill => skill.name))
    return catalog.snapshot().gated
      .filter(entry => !seen.has(entry.name))
      .map(entry => ({
        name: entry.name,
        description: entry.description ?? entry.displayName ?? '',
        modelInvocable: true,
      }))
  }

  /** Resolve a live or standing preset scope without creating an Agent. */
  private async scopeFor(
    agentPreset: string | undefined,
  ): Promise<({ key: ScopeKey } & AsyncDisposable) | undefined> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    try {
      return await presets.acquireScope(agentPreset)
    } catch {
      // An unknown or unusable recorded preset falls back to the global registry.
      return undefined
    }
  }
}

export default SessionSkillCatalog
