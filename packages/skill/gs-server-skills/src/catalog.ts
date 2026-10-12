/**
 * Host-plane share of the effective server-executed skill catalog. The
 * server skill provider publishes it; the bridge tools read it to decide
 * visibility and to resolve definition revisions.
 *
 * @module dsh-gs-server-skills/catalog
 */

import type {
  GsServerSkillCatalogController,
  GsServerSkillCatalogSnapshot,
  GsServerSkillRemoteEntry,
} from './types.ts'

/** Empty catalog published while signed out or against a legacy server. */
export const EMPTY_SERVER_SKILL_CATALOG: GsServerSkillCatalogSnapshot = Object.freeze({
  supported: false,
  types: Object.freeze([]),
  remotes: Object.freeze([]),
  gated: Object.freeze([]),
})

function sameEntries(
  left: readonly GsServerSkillRemoteEntry[],
  right: readonly GsServerSkillRemoteEntry[],
): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index]
    return other !== undefined && entry.name === other.name && entry.runtimeType === other.runtimeType
      && entry.definitionRevision === other.definitionRevision && entry.modelPolicy === other.modelPolicy
  })
}

/**
 * Create the catalog share consumed by the server-skill-tools bridge.
 * @returns the provider-owned controller; consumers see the readonly face.
 */
export function createGsServerSkillCatalog(): GsServerSkillCatalogController {
  let state: GsServerSkillCatalogSnapshot = EMPTY_SERVER_SKILL_CATALOG
  let invalidate: (() => void) | undefined
  const listeners = new Set<() => void>()
  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    invalidate() { invalidate?.() },
    resolveRemote(skillName, runtimeType) {
      // trusted-only entries never resolve on this lane: a direct bridge call
      // by name must not reach the execute endpoint.
      return state.remotes.find(entry => entry.name === skillName && entry.runtimeType === runtimeType
        && entry.modelPolicy !== 'trusted-only')
    },
    resolveGated(skillName, runtimeType) {
      return state.gated.find(entry => entry.name === skillName && entry.runtimeType === runtimeType)
    },
    update(snapshot) {
      // A registry discovery itself refreshes this projection. Invalidating
      // the registry on every identical refresh makes all of its bounded
      // collection attempts observe a new revision, so tool-skill never
      // publishes a model-facing catalog.
      if (state.supported === snapshot.supported
        && state.types.length === snapshot.types.length
        && state.types.every((type, index) => type === snapshot.types[index])
        && sameEntries(state.remotes, snapshot.remotes)
        && sameEntries(state.gated, snapshot.gated)) return
      state = snapshot
      for (const listener of listeners) listener()
    },
    bindInvalidate(next) { invalidate = next },
  }
}
