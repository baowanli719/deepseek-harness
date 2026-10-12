/**
 * Shared types for the gs-server skill packages: the narrow structural face
 * of the `ctx.gsServer` service this package consumes, the effective
 * server-executed skill catalog share, and the Cordis context augmentation
 * for that share.
 *
 * @module dsh-gs-server-skills/types
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GsLocalSkillRestriction, GsServerRuntimeType } from './contract.ts'
import type { ServerSkillPreferences } from './preferences.ts'

/**
 * The slice of the server-driven ClientConfig this package consumes. The
 * owning type lives in `@deepseek-ai/dsh-gs-server`; every field stays
 * optional here so the full wire config is assignable and old servers
 * default open.
 */
export interface GsSkillConfigView {
  /** Skill switch table; the reserved key `SKILLs` is the master switch. */
  readonly skills?: Record<string, 'on' | 'off'>
  readonly permissions?: {
    /** Local skill creation gate; an absent permission (old server) means allowed. */
    readonly allowLocalSkillCreate?: boolean
  }
  /** Admin-flagged local skill restrictions: name+hash pairs gated as trusted-only. */
  readonly localSkillRestrictions?: readonly GsLocalSkillRestriction[]
}

/**
 * Narrow structural face of the `ctx.gsServer` service
 * (`@deepseek-ai/dsh-gs-server`) this package consumes: the authenticated
 * fetch bridge already resolves the gsclaw endpoint, attaches the Bearer
 * token, and retries once after a single-flight refresh on 401. The real
 * service is structurally assignable; tests substitute a mock.
 */
export interface GsServerBridge {
  /**
   * Current real access token, held in memory only.
   * @returns the access token, or undefined while signed out.
   */
  getAccessToken(): Promise<string | undefined>
  /**
   * Authenticated request against the resolved gsclaw-server endpoint.
   * @param path - absolute API path beginning with `/`.
   * @param init - fetch init; the bridge owns the credential headers.
   * @returns the raw response; the caller owns body reading and status handling.
   */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /**
   * Latest cached server-driven ClientConfig.
   * @returns the cached config, or undefined before the first login delivers one.
   */
  getClientConfig(): GsSkillConfigView | undefined
}

/** One server-executed skill of the current effective catalog. */
export interface GsServerSkillRemoteEntry {
  readonly name: string
  readonly runtimeType: GsServerRuntimeType
  /** Revision the execute request must echo back. */
  readonly definitionRevision: string
  /** Normalized data-egress policy of the catalog entry. */
  readonly modelPolicy: 'standard' | 'trusted-only'
}

/** Effective remote-catalog projection consumed by the server-skill-tools bridge. */
export interface GsServerSkillCatalogSnapshot {
  /** Whether the server advertised the skill-execution protocol. */
  readonly supported: boolean
  /** Executable runtime types, intersected with the ones this package bridges. */
  readonly types: readonly GsServerRuntimeType[]
  /** Available server-executed skills of the latest successful sync. */
  readonly remotes: readonly GsServerSkillRemoteEntry[]
  /** Gated trusted-only entries retained for the private-session lane. */
  readonly gated: readonly GsServerSkillRemoteEntry[]
}

/**
 * Host-plane share of the effective server catalog. The provider publishes it;
 * the bridge tools read it to decide visibility and to resolve revisions.
 */
export interface GsServerSkillCatalog {
  /**
   * Latest effective snapshot; empty while signed out or unsynced.
   * @returns the immutable effective catalog projection.
   */
  snapshot(): GsServerSkillCatalogSnapshot
  /**
   * Subscribe to catalog changes.
   * @param listener - invoked synchronously after each accepted snapshot update.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void
  /** Invalidate cached catalogs and definitions after a `definition_changed`. */
  invalidate(): void
  /**
   * One available remote entry of the requested runtime type, if still listed.
   * Trusted-only entries never resolve on this lane: a direct bridge call by
   * name must not reach the execute endpoint.
   * @param name - exact skill name from the catalog.
   * @param runtimeType - executable runtime type to match.
   * @returns the catalog entry, or undefined.
   */
  resolveRemote(name: string, runtimeType: GsServerRuntimeType): GsServerSkillRemoteEntry | undefined
  /**
   * One gated trusted-only entry of the requested runtime type, if still
   * listed. Only the gated lane's execute path consults it, after its own
   * private-session check.
   * @param name - exact skill name from the catalog.
   * @param runtimeType - executable runtime type to match.
   * @returns the catalog entry, or undefined.
   */
  resolveGated(name: string, runtimeType: GsServerRuntimeType): GsServerSkillRemoteEntry | undefined
}

/** Provider-owned mutable face of the catalog share. */
export interface GsServerSkillCatalogController extends GsServerSkillCatalog {
  /** Publish a refreshed snapshot; identical snapshots are dropped without notifying. */
  update(snapshot: GsServerSkillCatalogSnapshot): void
  /** Wire the registry invalidation of the active provider registration. */
  bindInvalidate(invalidate: () => void): void
}

/**
 * Provider-side face of the `gsServerSkillGate` service: the mount point of
 * the gated trusted-only lane. `@deepseek-ai/dsh-sensitive-policy` consumes it
 * as an optional service through `ctx.get` under its own structural
 * declaration, so this name stays free of that package's `GsServerSkillGateFace`.
 */
export interface GsServerSkillGate {
  /**
   * Mount the gated trusted-only lane into one private agent's scoped context.
   * The lane re-checks `sensitivePolicy.isPrivate(sessionId)` per load; the
   * scoped registration unwinds with the agent.
   * @param scope - the private agent's scoped context.
   */
  mountPrivateLane(scope: Context): void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Effective server-executed skill catalog shared with the bridge tools. */
    gsServerSkillCatalog: GsServerSkillCatalog
    /** Private-session gated lane mount for trusted-only server skills. */
    gsServerSkillGate: GsServerSkillGate
    /** Managed local-skill root and registry refresh for product UI actions. */
    gsLocalSkills: {
      readonly managedRoot: string
      readonly homeRoot: string
      refresh(): void
    }
    /** Account-scoped switches shared by provider and product UI routes. */
    gsServerSkillPreferences: ServerSkillPreferences
  }
}
