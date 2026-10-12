/**
 * Sensitive-session policy core: the per-session data-egress state machine.
 *
 * Pure TypeScript — no Cordis or IO. A session starts `standard` /
 * `unclassified`; `enterPrivate` locks it to `trusted-only` at entry, and
 * sensitivity only ever rises (`unclassified` → `potential` → `sensitive`).
 * There is no downgrade: compaction, message deletion, and execution failures
 * never relax a session.
 *
 * Previous gs-worker releases wrote `sensitive/policy` transitions. The
 * current core replays them when a historical agent session is created.
 *
 * @module @deepseek-ai/dsh-sensitive-policy/core
 */

// The augmenting file must itself import '@deepseek-ai/cordis': without the
// import the ambient declaration shadows the real module instead of merging.
import type {} from '@deepseek-ai/cordis'
import type {
  SensitivePolicyEvent,
  SensitivePrivateCause,
  SensitiveSessionState,
} from './types.ts'

/** The state of a session with no recorded transition. */
export const STANDARD_SESSION_STATE: SensitiveSessionState = Object.freeze({
  inferencePolicy: 'standard',
  sensitivity: 'unclassified',
})

// The augmenting file must itself import '@deepseek-ai/cordis': without the
// import the ambient declaration shadows the real module instead of merging.
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Per-session sensitive-data policy core provided by `@deepseek-ai/dsh-sensitive-policy`. */
    sensitivePolicy: SensitivePolicyCore
  }
}

/**
 * Pure transition; returns the same reference when the event changes nothing.
 * @param state - the session's current policy state.
 * @param event - the transition to fold.
 * @returns the next policy state.
 */
export function applySensitivePolicyEvent(
  state: SensitiveSessionState,
  event: SensitivePolicyEvent,
): SensitiveSessionState {
  switch (event.kind) {
    case 'enter-private':
      return state.inferencePolicy === 'trusted-only'
        ? event.cause === 'explicit' && state.privateCause !== 'explicit'
          ? { ...state, privateCause: 'explicit' }
          : state
        : { ...state, inferencePolicy: 'trusted-only', privateCause: event.cause ?? 'explicit' }
    case 'mark-potential':
      return state.sensitivity === 'unclassified' ? { ...state, sensitivity: 'potential' } : state
    case 'mark-sensitive':
      return state.sensitivity === 'sensitive' ? state : { ...state, sensitivity: 'sensitive' }
    case 'use-provider':
      return state.provider === event.provider ? state : { ...state, provider: event.provider }
    case 'admit-skill':
      // The previous trusted-skill lane is unavailable here; never reopen it.
      return state
  }
}

/**
 * Rebuild one session's state from its recorded transitions.
 * @param events - the session's transitions in commit order.
 * @returns the folded policy state.
 */
export function replaySensitivePolicyEvents(events: readonly SensitivePolicyEvent[]): SensitiveSessionState {
  let state: SensitiveSessionState = STANDARD_SESSION_STATE
  for (const event of events) state = applySensitivePolicyEvent(state, event)
  return state
}

/**
 * Read-only face handed to consumers that must never mutate policy state.
 * Session ids are the string form of the session's branded `SessionId`.
 */
export interface SensitivePolicyView {
  /**
   * Whether the core holds a record of the session.
   * @param sessionId - the session id.
   * @returns whether the session is registered.
   */
  knows(sessionId: string): boolean
  /**
   * Whether the session is locked to trusted-only egress.
   * @param sessionId - the session id.
   * @returns whether the session is private.
   */
  isPrivate(sessionId: string): boolean
  /**
   * Read one session's policy state.
   * @param sessionId - the session id.
   * @returns the state; unknown sessions read as {@link STANDARD_SESSION_STATE}.
   */
  stateOf(sessionId: string): SensitiveSessionState
}

/**
 * Per-session sensitive-data policy state. Transitions are monotonic — privacy
 * and sensitivity never downgrade inside a process lifetime — and every commit
 * notifies subscribers after the state change lands.
 */
export class SensitivePolicyCore {
  private readonly sessions = new Map<string, SensitiveSessionState>()
  /** Transition listeners, notified after every committed state change. */
  private readonly listeners = new Set<(sessionId: string, event: SensitivePolicyEvent) => void>()

  /**
   * Subscribe to committed transitions.
   * @param listener - called with the session id after each committed change.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (sessionId: string, event: SensitivePolicyEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Read-only view for external consumers.
   * @returns the never-mutating face of this core.
   */
  view(): SensitivePolicyView {
    return {
      knows: sessionId => this.knows(sessionId),
      isPrivate: sessionId => this.isPrivate(sessionId),
      stateOf: sessionId => this.stateOf(sessionId),
    }
  }

  /**
   * Whether the session is registered with the core.
   * @param sessionId - the session id.
   * @returns whether the session is known.
   */
  knows(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * Register one session, seeding from a restored state when the caller has
   * one. Re-registration never downgrades an existing record.
   * @param sessionId - the session id.
   * @param restored - a previously folded state, when available.
   */
  registerSession(sessionId: string, restored?: SensitiveSessionState): void {
    if (this.sessions.has(sessionId)) {
      if (restored === undefined) return
      // Durable privacy cannot be erased by an earlier provisional in-memory registration.
      if (restored.inferencePolicy === 'trusted-only') this.enterPrivate(sessionId, restored.privateCause ?? 'explicit')
      if (restored.sensitivity === 'sensitive') this.markSensitive(sessionId)
      else if (restored.sensitivity === 'potential') this.markPotential(sessionId)
      if (this.stateOf(sessionId).provider === undefined && restored.provider !== undefined) this.noteProvider(sessionId, restored.provider)
      return
    }
    this.sessions.set(sessionId, restored ?? STANDARD_SESSION_STATE)
  }

  /**
   * Read one session's policy state.
   * @param sessionId - the session id.
   * @returns the state; unknown sessions read as {@link STANDARD_SESSION_STATE}.
   */
  stateOf(sessionId: string): SensitiveSessionState {
    return this.sessions.get(sessionId) ?? STANDARD_SESSION_STATE
  }

  /**
   * Whether the session is locked to trusted-only egress.
   * @param sessionId - the session id.
   * @returns whether the session is private.
   */
  isPrivate(sessionId: string): boolean {
    return this.stateOf(sessionId).inferencePolicy === 'trusted-only'
  }

  /**
   * Lock a session to trusted-only egress; committed at entry, never undone.
   * `provider-endpoint` marks the automatic judgement ("a trusted model
   * endpoint makes the conversation private"). Both causes enforce egress
   * restriction, and an explicit entry can upgrade an endpoint cause.
   * @param sessionId - the session id.
   * @param cause - what drove the session into private.
   */
  enterPrivate(sessionId: string, cause: SensitivePrivateCause = 'explicit'): void {
    this.commit(sessionId, { kind: 'enter-private', cause })
  }

  /**
   * Raise the session's sensitivity to at least `potential`.
   * @param sessionId - the session id.
   */
  markPotential(sessionId: string): void {
    this.commit(sessionId, { kind: 'mark-potential' })
  }

  /**
   * Raise the session's sensitivity to `sensitive`.
   * @param sessionId - the session id.
   */
  markSensitive(sessionId: string): void {
    this.commit(sessionId, { kind: 'mark-sensitive' })
  }

  /**
   * Record the provider route one session's model traffic used (on change only).
   * @param sessionId - the session id.
   * @param providerId - the provider route of the delegated request.
   */
  noteProvider(sessionId: string, providerId: string): void {
    this.commit(sessionId, { kind: 'use-provider', provider: providerId })
  }

  /**
   * Private sessions whose recorded provider route fails the trust predicate.
   * The caller executes the actual suspension; the core only judges. A private
   * session with no observed provider has nothing to suspend yet.
   * @param isTrusted - trust predicate over provider ids; fails closed.
   * @returns the suspended session ids, sorted for determinism.
   */
  suspendedSessions(isTrusted: (provider: string) => boolean): string[] {
    const suspended: string[] = []
    for (const [sessionId, state] of this.sessions) {
      if (state.inferencePolicy !== 'trusted-only' || state.provider === undefined) continue
      if (!isTrusted(state.provider)) suspended.push(sessionId)
    }
    return suspended.sort()
  }

  private commit(sessionId: string, event: SensitivePolicyEvent): void {
    const current = this.sessions.get(sessionId) ?? STANDARD_SESSION_STATE
    const next = applySensitivePolicyEvent(current, event)
    if (next === current) return
    this.sessions.set(sessionId, next)
    for (const listener of this.listeners) listener(sessionId, event)
  }
}
