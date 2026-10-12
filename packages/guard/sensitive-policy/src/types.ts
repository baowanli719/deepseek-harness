/**
 * Shared types for the sensitive-data compliance policy: per-session policy
 * state and transitions. The gsclaw-server contract (`gsServer` service,
 * ClientConfig, trust metadata, `gs-server/*` events) is owned by
 * `@deepseek-ai/dsh-gs-server`; this package consumes it, never mirrors it.
 *
 * @module @deepseek-ai/dsh-sensitive-policy/types
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection/types'

/** Data-egress policy of one session; `trusted-only` is the private session. */
export type SensitiveInferencePolicy = 'standard' | 'trusted-only'

/** Sensitivity label of one session's content; monotonically rises. */
export type SessionSensitivity = 'unclassified' | 'potential' | 'sensitive'

/** What drove one session into the private state. */
export type SensitivePrivateCause = 'explicit' | 'provider-endpoint'

/** One session's policy state. */
export interface SensitiveSessionState {
  readonly inferencePolicy: SensitiveInferencePolicy
  readonly sensitivity: SessionSensitivity
  /** What drove the session into private; absent while standard. */
  readonly privateCause?: SensitivePrivateCause
  /** Provider route the session's model traffic last used, if observed. */
  readonly provider?: string
}

/** Host-only checkpoint of privacy classification and whether the log records it. */
export interface SensitivePolicyProjectionState {
  readonly policy: SensitiveSessionState
  readonly hasTransitions: boolean
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'sensitive.policy': SensitivePolicyProjectionState
  }
}

/**
 * One policy transition of a session. Kept as a data sum type (rather than
 * bare method calls) so durable `sensitive/policy` session events replay
 * the same monotonic fold.
 */
export type SensitivePolicyEvent =
  | { readonly kind: 'enter-private'; readonly cause?: SensitivePrivateCause }
  | { readonly kind: 'mark-potential' }
  | { readonly kind: 'mark-sensitive' }
  | { readonly kind: 'admit-skill'; readonly name: string; readonly revision: string }
  | { readonly kind: 'use-provider'; readonly provider: string }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable monotonic policy transitions, restored before sensitive operations. */
    'sensitive/policy': SensitivePolicyEvent
  }
}

/**
 * Consumer-side view of the `gsServerSkillGate` service provided by
 * `@deepseek-ai/dsh-gs-server-skills`: the gated lane that makes trusted-only
 * catalog skills visible, loadable, and executable inside one private agent's
 * scope. The service key is outside this package's augmentation surface — the
 * provider plugin may not be composed — so consumers resolve it dynamically
 * through `ctx.get('gsServerSkillGate')` and treat its absence as a no-op.
 */
export interface GsServerSkillGateFace {
  /**
   * Mount the gated trusted-only skill lane into one private agent's scoped
   * context. The lane re-checks `sensitivePolicy.isPrivate(sessionId)` per
   * load and per execute; the registration unwinds with the agent's scope.
   * @param scope - the private agent's scoped context.
   */
  mountPrivateLane(scope: Context): void
}
