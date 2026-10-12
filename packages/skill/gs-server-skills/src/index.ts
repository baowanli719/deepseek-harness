/**
 * gsclaw-server skill integration: server-executed skill bridges
 * (`run_data_query` / `run_mcp_skill` tools executed by gsclaw-server), the
 * server skill provider feeding the `ctx.skills` registry (virtual
 * server-executed skills plus materialized `client` runtime bundles), the
 * administrator-controlled local skill trust lane (name + SHA-256
 * trusted-only), and the `gsServerSkillGate` service mounting the gated
 * trusted-only lane into private sessions' agent scopes.
 *
 * Function plugin (named exports, no default export). Requires the
 * `@deepseek-ai/dsh-gs-server` service (`ctx.gsServer`), the skill registry,
 * and the tool registry.
 *
 * @module @deepseek-ai/dsh-gs-server-skills
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
// Side-effect type import: declaration-merges `ctx.gsServer` and the
// `gs-server/*` events onto Context.
import type {} from '@deepseek-ai/dsh-gs-server'
import type {} from '@deepseek-ai/dsh-skill'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
// Type-only: pulls the `Context.sensitivePolicy` service declaration in; the
// service itself is resolved optionally at runtime through `ctx.get`.
import type {} from '@deepseek-ai/dsh-sensitive-policy'
import type {} from '@deepseek-ai/dsh-tools'
import { SkillBundleCache } from './bundle-cache.ts'
import { createGsServerSkillCatalog } from './catalog.ts'
import { GsSkillExecutionClient } from './execution.ts'
import { LocalSkillProvider } from './local-skill-provider.ts'
import { ServerSkillPreferences } from './preferences.ts'
import { ServerSkillProvider } from './server-skill-provider.ts'
import { registerServerSkillTools } from './server-skill-tools.ts'
import type {} from './types.ts'

export * from './contract.ts'
export * from './execution.ts'
export * from './bundle-cache.ts'
export * from './catalog.ts'
export * from './server-skill-provider.ts'
export * from './server-skill-tools.ts'
export * from './local-skill-provider.ts'
export * from './preferences.ts'
export type {
  GsServerBridge,
  GsServerSkillCatalog,
  GsServerSkillCatalogController,
  GsServerSkillCatalogSnapshot,
  GsServerSkillGate,
  GsServerSkillRemoteEntry,
  GsSkillConfigView,
} from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'gs-server-skills'

/** The skill registry, the tool registry, and the gsclaw-server client this plugin bridges. */
export const inject = ['skills', 'tools', 'gsServer']

/** Plugin configuration; deployment-varying values live here, not in code. */
export interface Config {
  /** Client-side ceiling of one server skill execute call in milliseconds. */
  executeTimeoutMs?: number
  /** Versioned cache root for `client` runtime skill bundles; defaults to `$DSH_HOME/gs-skills/bundles`. */
  bundleCacheRoot?: string
  /** Application-managed local skill root; defaults to `$DSH_HOME/local-skills`. */
  localSkillManagedRoot?: string
  /** User-home local skill root; defaults to `~/.skills`. */
  localSkillHomeRoot?: string
  /** Existing gs-worker account preference directory, when migrating. */
  preferenceRoot?: string
}

const DEFAULT_EXECUTE_TIMEOUT_MS = 120_000

/** Validate and default the plugin configuration. */
export const Config: Schema<Config> = z.object({
  executeTimeoutMs: z.number().default(DEFAULT_EXECUTE_TIMEOUT_MS),
  bundleCacheRoot: z.string(),
  localSkillManagedRoot: z.string(),
  localSkillHomeRoot: z.string(),
  preferenceRoot: z.string(),
})

/**
 * Register the server skill provider, the local skill provider, and the
 * server-executed bridge tools, and keep every registration in sync with the
 * server session and the server-driven ClientConfig.
 * @param ctx - host context carrying the skill registry, the tool registry, and `ctx.gsServer`.
 * @param config - plugin configuration; the Loader validates it against {@link Config}.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const executeTimeoutMs = config.executeTimeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS
  if (!Number.isInteger(executeTimeoutMs) || executeTimeoutMs < 1) {
    throw new Error('gs-server-skills: executeTimeoutMs must be a positive integer')
  }
  const managedRoot = config.localSkillManagedRoot ?? join(resolveDshHome(), 'local-skills')
  const homeRoot = config.localSkillHomeRoot ?? join(homedir(), '.skills')
  let localControl: SkillProviderControl | undefined
  ctx.provide('gsLocalSkills', {
    managedRoot,
    homeRoot,
    refresh() { localControl?.invalidate() },
  })

  const catalog = createGsServerSkillCatalog()
  ctx.provide('gsServerSkillCatalog', catalog)
  const client = new GsSkillExecutionClient({
    fetch: (path, init) => ctx.gsServer.fetch(path, init),
    executeTimeoutMs,
  })
  const bundleCache = new SkillBundleCache(
    config.bundleCacheRoot ?? join(resolveDshHome(), 'gs-skills', 'bundles'),
    () => {
      const session = ctx.gsServer.sessionView()
      return session.status === 'signed-in' && session.user !== undefined
        ? `${session.endpoint}#${String(session.user.id)}` : undefined
    },
  )

  // Monotonic session generation: any session or trust transition invalidates
  // the registry and bumps the generation, so a late response from a previous
  // session can never enter the new session's caches.
  let sessionGeneration = 0
  const providerControls = new Set<SkillProviderControl>()
  let serverProvider: ServerSkillProvider | undefined
  const invalidate = (): void => {
    for (const control of providerControls) control.invalidate()
  }
  const preferences = new ServerSkillPreferences({
    root: config.preferenceRoot ?? join(resolveDshHome(), 'gs-skills', 'preferences'),
    accountKey: () => {
      const session = ctx.gsServer.sessionView()
      return session.status === 'signed-in' && session.user !== undefined
        ? `${session.endpoint}#${String(session.user.id)}` : undefined
    },
    client,
    config: () => ctx.gsServer.getClientConfig(),
    invalidate,
  })
  ctx.provide('gsServerSkillPreferences', preferences)
  const sessionChanged = (): void => {
    sessionGeneration += 1
    invalidate()
  }
  ctx.on('gs-server/session-established', sessionChanged)
  ctx.on('gs-server/session-expired', sessionChanged)
  ctx.on('gs-server/trust-revoked', sessionChanged)
  ctx.on('gs-server/session-ended', sessionChanged)
  // Server-pushed skill switches and permission flips change the effective
  // catalog; invalidate so consumers refetch instead of serving cached revisions.
  ctx.on('gs-server/client-config-changed', sessionChanged)

  ctx.skills.registerProvider((control) => {
    providerControls.add(control)
    control.signal.addEventListener('abort', () => { providerControls.delete(control) }, { once: true })
    catalog.bindInvalidate(() => { control.invalidate() })
    serverProvider = new ServerSkillProvider({
      bridge: ctx.gsServer,
      client,
      bundleCache,
      catalog,
      preferences,
      // Optional service, resolved per call: the composition may load
      // sensitive-policy after this plugin, or not at all — an absent policy
      // keeps the gated lane closed.
      policy: () => ctx.get('sensitivePolicy'),
      sessionGeneration: () => sessionGeneration,
      logger: ctx.logger,
    }, control)
    return serverProvider
  })
  ctx.skills.registerProvider((control) => {
    localControl = control
    providerControls.add(control)
    control.signal.addEventListener('abort', () => {
      providerControls.delete(control)
      if (localControl === control) localControl = undefined
    }, { once: true })
    return new LocalSkillProvider(ctx.gsServer, { managedRoot, homeRoot, logger: ctx.logger })
  })

  registerServerSkillTools(ctx, client, catalog, { timeoutMs: executeTimeoutMs })

  // The gated trusted-only lane mount consumed by `@deepseek-ai/dsh-sensitive-policy`
  // for every private session's agent scope; the lane re-checks the session
  // against the policy core per load and per execute.
  ctx.provide('gsServerSkillGate', {
    mountPrivateLane(scopeCtx: Context) {
      /* v8 ignore start -- registerProvider runs its factory synchronously during apply, so no gate call observes a missing provider */
      if (serverProvider === undefined) {
        ctx.logger.warn('gs-server-skills: server skill gate requested before the provider was registered')
        return
      }
      /* v8 ignore stop */
      serverProvider.mountPrivateLane(scopeCtx)
    },
  })
}
