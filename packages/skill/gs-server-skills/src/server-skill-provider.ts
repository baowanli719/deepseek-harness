/**
 * Skill provider sourcing server-delivered skills from gsclaw-server into the
 * `ctx.skills` registry.
 *
 * Server-executed skills (`data-query` / `server-mcp`) stay virtual: their
 * `SkillDefinition` content comes from `GET /api/v1/skills/:name/definition`
 * and execution goes through the server-skill-tools bridge. `client` runtime
 * skills materialize their bundle from `GET /api/skills/:name/files` through
 * the versioned on-disk `SkillBundleCache` and load from the materialized
 * directory. Servers without the `skillExecution` meta capability receive an
 * empty catalog (the legacy `/api/skills` distribution is not migrated; see
 * the package README).
 *
 * Trusted-only entries are listed non-invocable on the standard lane and
 * retained in the catalog's `gated` list; `mountPrivateLane` mounts a scoped
 * lane provider into one private agent's context, whose loads re-check
 * `sensitivePolicy.isPrivate(sessionId)` per call.
 *
 * @module dsh-gs-server-skills/server-skill-provider
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
  SkillProviderObservation,
  SkillViewOptions,
} from '@deepseek-ai/dsh-skill'
import { BUNDLED_SKILL_RANK, isSkillName } from '@deepseek-ai/dsh-skill'
import type { MaterializedSkillBundle, SkillBundleFile } from './bundle-cache.ts'
import {
  GS_SERVER_RUNTIME_TYPES,
  effectiveSkillModelPolicy,
  skillExecutionPolicyVersion,
  type GsSkillCatalogResponse,
  type GsSkillDefinitionResponse,
  type GsSkillModelPolicy,
  type GsSkillQueryParam,
  type GsServerMeta,
  type GsServerRuntimeType,
} from './contract.ts'
import type { GsSkillExecutionClient } from './execution.ts'
import type { ServerSkillPreferences } from './preferences.ts'
import { EMPTY_SERVER_SKILL_CATALOG } from './catalog.ts'
import type {
  GsServerBridge,
  GsServerSkillCatalogController,
  GsServerSkillRemoteEntry,
} from './types.ts'

/** Provider name in the `ctx.skills` registry. */
export const SERVER_SKILL_PROVIDER_NAME = 'gsclaw-server'

/**
 * Rank above BUNDLED_SKILL_RANK and below the local provider's
 * LOCAL_SKILL_RANK: within a registry layer candidates sort by rank ascending
 * and the first wins a duplicate name, so server-delivered skills win
 * same-name conflicts against bundled and local skills.
 */
export const SERVER_SKILL_RANK = BUNDLED_SKILL_RANK + 100

/** A transient discovery result must never enter the registry's completed cache. */
function arrayShape(value: unknown): boolean { return Array.isArray(value) }
function recordShape(value: unknown): boolean { return typeof value === 'object' && value !== null }

const INCOMPLETE_CATALOG: SkillProviderObservation = { candidates: [], complete: false }

/** In-memory remote-definition cache cap; session changes clear it wholesale. */
const MAX_REMOTE_DEFINITIONS = 512

/** Entry document of a skill bundle inside the materialized cache directory. */
const SKILL_ENTRY_FILE = 'SKILL.md'

/** Version strings double as cache path segments, so keep them path-safe. */
const SAFE_SKILL_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u

/**
 * Strip the YAML frontmatter block a definition body may carry.
 * @param text - the raw definition body.
 * @returns the body without its leading frontmatter, unchanged when none is present.
 */
export function stripSkillFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, '')
}

/** Minimal logger face the provider needs; `ctx.logger` satisfies it. */
export interface ServerSkillLogger {
  warn(format: string, ...param: unknown[]): void
}

/**
 * Narrow structural face of the versioned skill bundle cache
 * (`SkillBundleCache` from `./bundle-cache.ts`) this provider consumes; the
 * real cache is structurally assignable and tests substitute a stub.
 */
export interface ServerSkillBundleCache {
  /**
   * Validate and extract one fetched bundle into the versioned cache.
   * @param name - skill name from the catalog.
   * @param version - skill version the catalog carried; the cache keys on it.
   * @param files - base64 bundle files from the `/files` endpoint.
   * @returns the materialized bundle directory and its frontmatter-stripped entry body.
   */
  materialize(name: string, version: string, files: readonly SkillBundleFile[]): Promise<MaterializedSkillBundle>
  /**
   * Read an already materialized bundle without touching the network.
   * @param name - skill name.
   * @param version - skill version of the candidate being loaded.
   * @returns the cached bundle, or undefined when absent or incomplete.
   */
  readCached(name: string, version: string): Promise<MaterializedSkillBundle | undefined>
}

/** Inputs of the server skill provider. */
export interface ServerSkillProviderOptions {
  /** Authenticated gsclaw-server bridge. */
  readonly bridge: GsServerBridge
  /** Execution client for the meta/catalog/definition/files calls. */
  readonly client: GsSkillExecutionClient
  /** Versioned on-disk cache materializing `client` runtime skill bundles. */
  readonly bundleCache: ServerSkillBundleCache
  /** Catalog share published for the bridge tools. */
  readonly catalog: GsServerSkillCatalogController
  /** Account-local switches migrated from the previous desktop product. */
  readonly preferences?: ServerSkillPreferences
  /**
   * Per-call resolver of the optional sensitive-policy view the gated lane
   * consults per load. The `sensitivePolicy` service may not be composed (or
   * may compose after this plugin), so it is resolved lazily; a resolver
   * yielding undefined keeps the gated lane closed.
   */
  readonly policy?: () => GsSessionPolicyView | undefined
  /**
   * Monotonic session generation; the plugin bumps it on session-establish
   * and session-expiry events so a late response from a previous session can
   * never enter the new session's caches.
   */
  readonly sessionGeneration: () => number
  /** Optional logger for sync failures; discovery itself stays silent. */
  readonly logger?: ServerSkillLogger
}

/** Server skill-execution capability resolved from the meta handshake. */
export interface GsSkillExecutionSupport {
  readonly supported: boolean
  /** Executable runtime types, intersected with the ones this package bridges. */
  readonly types: readonly GsServerRuntimeType[]
  /** Sensitive-skill policy protocol version; absent on servers without the capability. */
  readonly policyVersion?: number
}

/**
 * Resolve the skill-execution capability of one meta handshake. Servers that
 * predate the field return undefined, selecting the empty legacy projection.
 * @param meta - parsed meta handshake.
 * @returns the capability intersected with the bridged runtime types, or undefined.
 */
export function parseSkillExecutionSupport(meta: GsServerMeta): GsSkillExecutionSupport | undefined {
  const capability = meta.skillExecution
  if (capability === undefined || capability === null) return undefined
  const advertised = arrayShape(capability.types) ? capability.types : []
  const types = advertised.filter((type): type is GsServerRuntimeType =>
    (GS_SERVER_RUNTIME_TYPES as readonly string[]).includes(type))
  const policyVersion = skillExecutionPolicyVersion(capability)
  return { supported: true, types, ...(policyVersion === undefined ? {} : { policyVersion }) }
}

/** Character cap of the tool listing appended to a remote skill's content. */
export const MAX_REMOTE_TOOL_LISTING_CHARS = 16 * 1024
/** Per-entry description cap so one verbose entry cannot eat the whole listing. */
const MAX_REMOTE_LISTING_DESCRIPTION_CHARS = 500
/** Per-entry schema cap; oversized schemas are noted instead of embedded. */
const MAX_REMOTE_LISTING_SCHEMA_CHARS = 4096

/** Clip one free-text field from the server to a bounded single block. */
function clipListingText(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

/**
 * Render the tool surface of one server-executed skill definition as Markdown.
 * A remote skill reaches the model only through its `SkillDefinition.content`,
 * so the allowlisted tool names and argument shapes must ride along there;
 * guessing them fails server-side with `invalid_arguments`. Returns an empty
 * string when the definition declares no tool surface for its runtime type.
 * @param skillName - the skill the listing instructs the model to name.
 * @param runtimeType - executable runtime type of the skill.
 * @param response - the parsed definition response.
 * @returns the Markdown listing, or an empty string.
 */
export function renderRemoteToolListing(
  skillName: string,
  runtimeType: GsServerRuntimeType,
  response: GsSkillDefinitionResponse,
): string {
  const sections: string[] = []
  if (runtimeType === 'server-mcp' && response.mcp !== undefined && arrayShape(response.mcp.tools)) {
    const tools = response.mcp.tools.filter(tool =>
      recordShape(tool) && typeof tool.name === 'string' && tool.name !== '')
    if (tools.length > 0) {
      const lines = [
        '## Available tools (call via `run_mcp_skill`)',
        '',
        `Call these through the \`run_mcp_skill\` tool: set \`skill\` to \`${skillName}\`, \`tool\` to one of the names below, and \`arguments\` to match that tool's input schema. Use only the tool names listed here.`,
      ]
      for (const tool of tools) {
        lines.push('', `### \`${tool.name}\``)
        if (typeof tool.description === 'string' && tool.description.trim() !== '') {
          lines.push(clipListingText(tool.description, MAX_REMOTE_LISTING_DESCRIPTION_CHARS))
        }
        if (tool.inputSchema !== undefined) {
          const schema = JSON.stringify(tool.inputSchema)
          lines.push(schema.length <= MAX_REMOTE_LISTING_SCHEMA_CHARS
            ? `Input schema: ${schema}`
            : 'Input schema: (too large to inline; start with no arguments and follow the server error guidance)')
        }
      }
      sections.push(lines.join('\n'))
    }
  }
  if (runtimeType === 'data-query' && response.dataQuery !== undefined && arrayShape(response.dataQuery.queries)) {
    const queries = response.dataQuery.queries.filter(query =>
      recordShape(query) && typeof query.name === 'string' && query.name !== '')
    if (queries.length > 0) {
      const lines = [
        '## Available query templates (call via `run_data_query`)',
        '',
        `Call these through the \`run_data_query\` tool: set \`skill\` to \`${skillName}\`, \`query\` to one of the template names below, and \`params\` keyed by the declared parameter names. Use only the template names listed here.`,
      ]
      for (const query of queries) {
        lines.push('', `### \`${query.name}\``)
        if (typeof query.description === 'string' && query.description.trim() !== '') {
          lines.push(clipListingText(query.description, MAX_REMOTE_LISTING_DESCRIPTION_CHARS))
        }
        const params = arrayShape(query.params)
          ? query.params.filter((param: GsSkillQueryParam) =>
            recordShape(param) && typeof param.name === 'string' && param.name !== '')
          : []
        if (params.length > 0) {
          lines.push('Parameters:')
          for (const param of params) {
            const type = typeof param.type === 'string' && param.type !== '' ? param.type : 'unknown'
            const requirement =  param.required ? 'required' : 'optional'
            const choices = arrayShape(param.enum)
              ? param.enum?.filter((choice: unknown): choice is string => typeof choice === 'string')
              : []
            const allowed = (choices ?? []).length > 0 ? ` Allowed: ${choices?.join(', ')}.` : ''
            const description = typeof param.description === 'string' && param.description.trim() !== ''
              ? ` ${clipListingText(param.description, MAX_REMOTE_LISTING_DESCRIPTION_CHARS)}`
              : ''
            lines.push(`- \`${param.name}\` (${type}, ${requirement}).${description}${allowed}`)
          }
        }
      }
      sections.push(lines.join('\n'))
    }
  }
  const listing = sections.join('\n\n')
  return listing.length <= MAX_REMOTE_TOOL_LISTING_CHARS
    ? listing
    : `${listing.slice(0, MAX_REMOTE_TOOL_LISTING_CHARS)}\n\n[Tool listing truncated to stay within size limits.]`
}

/** Opaque candidate locator handed back to `get()` for a server-executed skill. */
interface RemoteSkillLocator {
  readonly kind: 'remote'
  readonly name: string
  readonly version: string
  readonly runtimeType: GsServerRuntimeType
  readonly revision: string
  /** Normalized policy the catalog carried when this candidate was listed. */
  readonly policy: GsSkillModelPolicy
}

/** Opaque candidate locator handed back to `get()` for a client bundle skill. */
interface ClientSkillLocator {
  readonly kind: 'client'
  readonly name: string
  readonly version: string
  readonly revision: string
  /** Normalized policy the catalog carried when this candidate was listed. */
  readonly policy: GsSkillModelPolicy
}

/** Narrow one unknown locator to the client bundle shape without trusting it. */
function asClientLocator(locator: unknown): ClientSkillLocator | undefined {
  if (typeof locator !== 'object' || locator === null) return undefined
  const record = locator as Partial<ClientSkillLocator>
  if (record.kind !== 'client' || typeof record.name !== 'string'
    || typeof record.version !== 'string' || typeof record.revision !== 'string'
    || (record.policy !== 'standard' && record.policy !== 'trusted-only')) {
    return undefined
  }
  return record as ClientSkillLocator
}

/** Narrow one unknown locator to the remote shape without trusting it. */
function asRemoteLocator(locator: unknown): RemoteSkillLocator | undefined {
  if (typeof locator !== 'object' || locator === null) return undefined
  const record = locator as Partial<RemoteSkillLocator>
  if (record.kind !== 'remote' || typeof record.name !== 'string'
    || typeof record.version !== 'string' || typeof record.revision !== 'string'
    || (record.policy !== 'standard' && record.policy !== 'trusted-only')
    || (record.runtimeType !== 'data-query' && record.runtimeType !== 'server-mcp')) {
    return undefined
  }
  return record as RemoteSkillLocator
}

/**
 * Invocation flags of a listed-but-gated trusted-only candidate: visible in
 * the skill list, filtered out of the model catalog and the slash menu.
 */
const NON_INVOCABLE = { modelInvocable: false, userInvocable: false }

/** Narrow policy face the gated lane consults per load; `SensitivePolicyCore` satisfies it. */
export interface GsSessionPolicyView {
  /**
   * Whether the session is locked to trusted-only egress.
   * @param sessionId - the session id.
   * @returns whether the session is private.
   */
  isPrivate(sessionId: string): boolean
}

/** One gated trusted-only server skill retained for the private lane. */
interface GatedRemoteSkill {
  readonly name: string
  readonly version: string
  readonly displayName: string
  readonly description: string
  readonly runtimeType: GsServerRuntimeType
  readonly revision: string
}

/** The scoped lane provider name serving gated candidates to private agents. */
export const GATED_SKILL_LANE_NAME = `${SERVER_SKILL_PROVIDER_NAME}-gated`

/** Extract the session id of one registry lookup scope without trusting it. */
function sessionIdOfScope(scope: unknown): string | undefined {
  if (typeof scope !== 'object' || scope === null) return undefined
  const id = (scope as { session?: { id?: unknown } }).session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Scoped provider serving the gated trusted-only lane of one private agent.
 * Registration into the agent's scope layer leaves every other view untouched.
 */
class GatedSkillLaneProvider implements SkillProvider {
  readonly name = GATED_SKILL_LANE_NAME
  constructor(private readonly main: ServerSkillProvider) {}

  list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    options.signal?.throwIfAborted()
    return Promise.resolve(this.main.gatedCandidates())
  }

  get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    return this.main.getGated(candidate, options)
  }
}

/**
 * Skill provider backed by gsclaw-server's skill-execution protocol; never
 * touches the local skill roots. `client` runtime bundles materialize into
 * the configured versioned cache, never into a skill root.
 */
export class ServerSkillProvider implements SkillProvider {
  readonly name = SERVER_SKILL_PROVIDER_NAME
  /** In-memory remote definitions keyed by name and definition revision. */
  private readonly remoteDefinitions = new Map<string, SkillDefinition>()
  /** Session generation the current definition cache belongs to. */
  private cachedGeneration: number | undefined
  /** Policy protocol version of the latest meta handshake; undefined pre-capability. */
  private policyVersion: number | undefined
  /** Gated trusted-only entries of the latest successful catalog sync. */
  private gatedSkills: readonly GatedRemoteSkill[] = []

  constructor(
    private readonly options: ServerSkillProviderOptions,
    private readonly control: SkillProviderControl,
  ) {}

  /** Whether the current session is signed in. */
  private async signedIn(): Promise<boolean> {
    return await this.options.bridge.getAccessToken() !== undefined
  }

  /** Effective skill switch table of the latest server-driven ClientConfig. */
  private skillControls(): Record<string, 'on' | 'off'> | undefined {
    return this.options.bridge.getClientConfig()?.skills
  }

  /** Drop every remote definition cached under a different session generation. */
  private pruneRemoteState(): void {
    const generation = this.options.sessionGeneration()
    if (this.cachedGeneration === generation) return
    this.cachedGeneration = generation
    this.remoteDefinitions.clear()
  }

  /** Signed-out housekeeping: caches and the published catalog lose all remote entries. */
  private resetRemoteState(): void {
    this.cachedGeneration = this.options.sessionGeneration()
    this.remoteDefinitions.clear()
    this.policyVersion = undefined
    this.gatedSkills = []
    this.options.catalog.update(EMPTY_SERVER_SKILL_CATALOG)
  }

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    // No session or an unreachable server yields an empty catalog; discovery
    // must never break host startup.
    if (!await this.signedIn()) {
      this.resetRemoteState()
      return INCOMPLETE_CATALOG
    }
    const generation = this.options.sessionGeneration()
    this.pruneRemoteState()

    let meta: GsServerMeta
    try {
      meta = await this.options.client.meta({ ...(options.signal === undefined ? {} : { signal: options.signal }) })
    } catch (cause) {
      return this.syncFailed(cause)
    }
    // A sign-out or session switch during the handshake discards the response.
    if (this.options.sessionGeneration() !== generation) return INCOMPLETE_CATALOG
    this.policyVersion = skillExecutionPolicyVersion(meta.skillExecution)
    const support = parseSkillExecutionSupport(meta)
    if (support === undefined) {
      // Servers without the skill-execution capability receive the empty
      // projection: the legacy bundle distribution is not migrated.
      this.gatedSkills = []
      this.options.catalog.update(EMPTY_SERVER_SKILL_CATALOG)
      return []
    }
    return this.listCatalog(options, generation, support)
  }

  /** Record a sync failure, keeping the last good snapshot. */
  private syncFailed(cause: unknown): SkillProviderObservation {
    this.options.logger?.warn(
      `gs-server-skills: server skill sync failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
    // An empty complete array would be cached by SkillRegistry, preventing
    // later turns from retrying after a transient server failure.
    return INCOMPLETE_CATALOG
  }

  /**
   * Capability-aware distribution: `GET /api/v1/skills/catalog` is prefiltered
   * by the server and carries every runtime type. Executable remote types
   * become virtual candidates, `client` entries become bundle candidates, and
   * unrecognized or unsupported types never load.
   */
  private async listCatalog(
    options: SkillLookupOptions,
    generation: number,
    support: GsSkillExecutionSupport,
  ): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    let response: GsSkillCatalogResponse
    try {
      response = await this.options.client.catalog({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (cause) {
      return this.syncFailed(cause)
    }
    if (this.options.sessionGeneration() !== generation) return INCOMPLETE_CATALOG
    const skills = arrayShape(response.skills) ? response.skills : []
    const controls = this.skillControls()
    const masterOff = controls?.SKILLs === 'off'
    const candidates: SkillCandidate[] = []
    const remotes: GsServerSkillRemoteEntry[] = []
    const gated: GsServerSkillRemoteEntry[] = []
    const gatedSkills: GatedRemoteSkill[] = []
    let unsupported = 0
    const declared = support.policyVersion !== undefined
    for (const skill of skills) {
      if (!isSkillName(skill.name)) continue
      if (masterOff) continue
      // The switch table is subtractive: only an explicit per-skill `off`
      // removes a delivered skill; unlisted and `on` entries pass through.
      if (controls?.[skill.name] === 'off') continue
      if (this.options.preferences === undefined
        ? skill.defaultEnabled === false
        : !await this.options.preferences.enabledFor(skill)) continue
      const modelPolicy = effectiveSkillModelPolicy(declared, skill.modelPolicy)
      const description = typeof skill.description === 'string' ? skill.description : ''
      const revision = typeof skill.definitionRevision === 'string' ? skill.definitionRevision : ''
      const trustedOnly = modelPolicy === 'trusted-only'
      if (skill.runtimeType === 'client') {
        // Client-runtime entries keep the bundle flow: the candidate loads
        // through client.files + the versioned bundle cache in get(). A
        // trusted-only entry is listed for visibility but stays non-invocable,
        // and get() refuses its body at the policy fence.
        candidates.push({
          name: skill.name,
          description,
          invocation: trustedOnly ? NON_INVOCABLE : { modelInvocable: true, userInvocable: true },
          source: 'server',
          provider: SERVER_SKILL_PROVIDER_NAME,
          rank: SERVER_SKILL_RANK,
          locator: {
            kind: 'client',
            name: skill.name,
            version: skill.version,
            revision,
            policy: modelPolicy,
          } satisfies ClientSkillLocator,
          metadata: {
            displayName: skill.displayName,
            version: skill.version,
            runtimeType: 'client',
            execution: 'desktop',
            definitionRevision: revision,
            ...(trustedOnly ? { policy: 'trusted-only' } : {}),
          },
        })
        continue
      }
      const remoteType = (GS_SERVER_RUNTIME_TYPES as readonly string[]).includes(skill.runtimeType)
        && support.types.includes(skill.runtimeType as GsServerRuntimeType)
        ? skill.runtimeType as GsServerRuntimeType
        : undefined
      if (remoteType === undefined) {
        // Unrecognized or not executable here: never silently demoted to a
        // local bundle, never loadable.
        unsupported += 1
        continue
      }
      // trusted-only skills are listed like every other delivered skill but
      // carry a non-invocable candidate on the standard lane: the model
      // catalog and the slash menu filter them out, get() refuses the body,
      // and the standard bridge never resolves them. The enabled remote ones
      // are retained for the gated private-session lane (getGated).
      candidates.push({
        name: skill.name,
        description,
        invocation: trustedOnly ? NON_INVOCABLE : { modelInvocable: true, userInvocable: true },
        source: 'server',
        provider: SERVER_SKILL_PROVIDER_NAME,
        rank: SERVER_SKILL_RANK,
        locator: {
          kind: 'remote',
          name: skill.name,
          version: skill.version,
          runtimeType: remoteType,
          revision,
          policy: modelPolicy,
        } satisfies RemoteSkillLocator,
        metadata: {
          displayName: skill.displayName,
          version: skill.version,
          runtimeType: remoteType,
          execution: 'server',
          definitionRevision: revision,
          ...(trustedOnly ? { policy: 'trusted-only' } : {}),
        },
      })
      if (trustedOnly) {
        gated.push({ name: skill.name, runtimeType: remoteType, definitionRevision: revision, modelPolicy })
        gatedSkills.push({
          name: skill.name,
          version: skill.version,
          displayName: skill.displayName,
          description,
          runtimeType: remoteType,
          revision,
        })
      } else {
        remotes.push({ name: skill.name, runtimeType: remoteType, definitionRevision: revision, modelPolicy })
      }
    }
    if (this.options.sessionGeneration() !== generation) return INCOMPLETE_CATALOG
    if (unsupported > 0) {
      this.options.logger?.warn(
        `gs-server-skills: ${String(unsupported)} server skill(s) skipped: runtime type unsupported by this client`,
      )
    }
    this.gatedSkills = gatedSkills
    this.options.catalog.update({ supported: true, types: support.types, remotes, gated })
    return candidates
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const generation = this.options.sessionGeneration()
    if (!await this.signedIn() || !isSkillName(candidate.name)
      || this.skillControls()?.SKILLs === 'off'
      || this.skillControls()?.[candidate.name] === 'off') return undefined
    if (this.options.preferences !== undefined
      && !await this.options.preferences.enabledFor({ name: candidate.name })) return undefined
    // The policy fence: trusted-only candidates are listed for visibility but
    // their body never loads on the standard lane. Private sessions load the
    // same skill through the gated lane (getGated), which re-checks the
    // session against the policy core.
    if (candidate.metadata?.policy === 'trusted-only') return undefined
    const remote = asRemoteLocator(candidate.locator)
    const definition = remote !== undefined
      ? await this.getRemote(candidate, remote, options, 'standard')
      : await this.getClientBundle(candidate, options)
    if (this.options.sessionGeneration() !== generation) return undefined
    return definition
  }

  /**
   * Mount the gated trusted-only lane into one private agent's scoped context.
   * The lane lists only the retained gated entries and loads them solely for
   * sessions the policy core still marks private. Agent scopes declare no
   * inject list, so the registry is resolved through `ctx.get` — the returned
   * service is still bound to the accessing scope, so the registration files
   * into the agent's layer and unwinds with it.
   * @param scopeCtx - the private agent's scoped context.
   */
  mountPrivateLane(scopeCtx: Context): void {
    const skills = scopeCtx.get('skills')
    if (skills === undefined) throw new Error('gs-server-skills: the skills registry is unavailable in the gated lane scope')
    skills.registerProvider((control) => {
      // Catalog refreshes must reach the lane's registration too.
      const unsubscribe = this.options.catalog.subscribe(() => { control.invalidate() })
      control.signal.addEventListener('abort', unsubscribe, { once: true })
      return new GatedSkillLaneProvider(this)
    })
  }

  /**
   * Invocable candidates of the gated lane for a private scope's catalog.
   * @returns one candidate per retained gated entry of the latest sync.
   */
  gatedCandidates(): SkillCandidate[] {
    return this.gatedSkills.map(skill => ({
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'server',
      provider: GATED_SKILL_LANE_NAME,
      rank: SERVER_SKILL_RANK,
      locator: {
        kind: 'remote',
        name: skill.name,
        version: skill.version,
        runtimeType: skill.runtimeType,
        revision: skill.revision,
        policy: 'trusted-only',
      } satisfies RemoteSkillLocator,
      metadata: {
        displayName: skill.displayName,
        version: skill.version,
        runtimeType: skill.runtimeType,
        execution: 'server',
        definitionRevision: skill.revision,
        policy: 'trusted-only',
      },
    }))
  }

  /**
   * Load one gated skill's definition for a private session. The lane refuses
   * when the lookup carries no session scope or the session is not private.
   * @param candidate - the lane's winning candidate.
   * @param options - lookup options; the registry carries the viewing scope.
   * @returns the full skill body, or undefined when the session check fails.
   */
  async getGated(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    const generation = this.options.sessionGeneration()
    if (!await this.signedIn() || this.skillControls()?.SKILLs === 'off'
      || this.skillControls()?.[candidate.name] === 'off') return undefined
    if (this.options.preferences !== undefined
      && !await this.options.preferences.enabledFor({ name: candidate.name })) return undefined
    const remote = asRemoteLocator(candidate.locator)
    if (remote === undefined || remote.policy !== 'trusted-only') return undefined
    const sessionId = sessionIdOfScope((options as SkillViewOptions).scope)
    const policy = this.options.policy?.()
    if (sessionId === undefined || policy === undefined || !policy.isPrivate(sessionId)) return undefined
    const definition = await this.getRemote(candidate, remote, options, 'gated')
    return this.options.sessionGeneration() === generation ? definition : undefined
  }

  /**
   * Load one client-runtime skill: serve the versioned bundle cache when the
   * exact `<name>@<version>` is already materialized, otherwise fetch
   * `GET /api/skills/:name/files` and materialize it first. The loaded
   * definition resolves its relative resources against the cache directory.
   */
  private async getClientBundle(
    candidate: SkillCandidate,
    options: SkillLookupOptions,
  ): Promise<SkillDefinition | undefined> {
    const locator = asClientLocator(candidate.locator)
    if (locator === undefined || !isSkillName(locator.name) || !SAFE_SKILL_VERSION.test(locator.version)) {
      return undefined
    }
    const generation = this.options.sessionGeneration()
    let files: readonly SkillBundleFile[]
    try {
      const response = await this.options.client.files(locator.name, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      if (response.name !== locator.name) throw new Error(`bundle name mismatch: ${response.name}`)
      files = response.files
    } catch (cause) {
      this.options.logger?.warn(
        `gs-server-skills: server skill bundle fetch failed for ${locator.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      return undefined
    }
    // A sign-out or session switch during the fetch discards the response.
    if (this.options.sessionGeneration() !== generation) return undefined
    let bundle: MaterializedSkillBundle
    try {
      bundle = await this.options.bundleCache.materialize(locator.name, locator.version, files)
    } catch (cause) {
      this.options.logger?.warn(
        `gs-server-skills: server skill bundle refused for ${locator.name}@${locator.version}: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      return undefined
    }
    return this.options.sessionGeneration() === generation ? this.clientBundleDefinition(candidate, bundle) : undefined
  }

  /** Project one materialized bundle into the loaded definition of its candidate. */
  private clientBundleDefinition(candidate: SkillCandidate, bundle: MaterializedSkillBundle): SkillDefinition {
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
      content: bundle.body,
      path: join(bundle.path, SKILL_ENTRY_FILE),
      resourceBase: { kind: 'directory', path: bundle.path },
      ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
    }
  }

  /**
   * Load one server-executed skill's definition; no bundle ever lands on disk.
   * The standard lane loads standard definitions only; the gated lane loads
   * trusted-only ones.
   */
  private async getRemote(
    candidate: SkillCandidate,
    locator: RemoteSkillLocator,
    options: SkillLookupOptions,
    lane: 'standard' | 'gated',
  ): Promise<SkillDefinition | undefined> {
    if (!isSkillName(locator.name)) return undefined
    const generation = this.options.sessionGeneration()
    this.pruneRemoteState()
    const cacheKey = `${locator.name}@${locator.revision}`
    const cached = this.remoteDefinitions.get(cacheKey)
    if (cached !== undefined) return cached

    let response: GsSkillDefinitionResponse
    try {
      response = await this.options.client.definition(locator.name, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (cause) {
      this.options.logger?.warn(
        `gs-server-skills: server skill definition fetch failed for ${locator.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
      return undefined
    }
    // A sign-out or session switch during the fetch discards the response:
    // nothing from the previous session enters the new session's cache.
    if (this.options.sessionGeneration() !== generation) return undefined
    if (typeof response.content !== 'string' || response.name !== locator.name) {
      this.options.logger?.warn(`gs-server-skills: server skill definition refused for ${locator.name}`)
      return undefined
    }
    if (response.runtimeType !== locator.runtimeType || response.definitionRevision !== locator.revision) {
      // The definition moved under the catalog entry that drove this load;
      // force a re-list so the next lookup uses the current revision.
      this.options.logger?.warn(`gs-server-skills: server skill definition revision moved for ${locator.name}`)
      this.control.invalidate()
      return undefined
    }
    const definitionPolicy = effectiveSkillModelPolicy(this.policyVersion !== undefined, response.modelPolicy)
    // A policy that moved under the catalog entry that drove this load forces
    // a re-list so the next lookup uses the new policy; the standard lane
    // never loads trusted-only definitions, the gated lane loads nothing else.
    const policyMatches = lane === 'gated'
      ? definitionPolicy === 'trusted-only'
      : definitionPolicy === locator.policy && definitionPolicy !== 'trusted-only'
    if (!policyMatches) {
      this.options.logger?.warn(`gs-server-skills: server skill definition policy moved for ${locator.name}`)
      this.control.invalidate()
      return undefined
    }
    const body = stripSkillFrontmatter(response.content)
    const listing = renderRemoteToolListing(candidate.name, locator.runtimeType, response)
    const definition: SkillDefinition = {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      source: candidate.source,
      provider: candidate.provider,
      content: listing === '' ? body : body === '' ? listing : `${body}\n\n${listing}`,
      metadata: {
        ...(candidate.metadata ?? {}),
        execution: 'server',
        runtimeType: locator.runtimeType,
        definitionRevision: locator.revision,
      },
    }
    if (this.remoteDefinitions.size >= MAX_REMOTE_DEFINITIONS) this.remoteDefinitions.clear()
    this.remoteDefinitions.set(cacheKey, definition)
    return definition
  }
}
