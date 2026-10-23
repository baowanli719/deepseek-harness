/**
 * Shared types for the gsclaw model-gateway adapter: the narrow
 * `gsLlmGateway` service face this plugin publishes. The consumed
 * `gsServer` service contract and the `gs-server/*` events are declared by
 * `@deepseek-ai/dsh-gs-server`.
 *
 * @module dsh-llm-gs-gateway/types
 */

/**
 * The loopback gateway face this plugin publishes as `ctx.gsLlmGateway`:
 * everything a composition needs to route a provider profile through the
 * proxy and to wire the per-boot token into the credential plane.
 */
export interface GsLlmGateway {
  /** Loopback origin of the running proxy, e.g. `http://127.0.0.1:43123`. */
  readonly origin: string
  /** Per-boot placeholder token provider profiles resolve through the credential reference. */
  readonly token: string
  /**
   * Provider-profile baseURL route for one server provider id.
   * @param providerId - provider id inside the route grammar.
   * @returns the loopback baseURL naming that provider.
   */
  providerBaseUrl(providerId: string): string
  /**
   * Repoint the mirrored provider plan at the live proxy origin after a model
   * request found its mirrored baseURL refusing connections: the running
   * proxy always knows its own bound port, while a mirror written for an
   * earlier origin (or never persisted) leaves the running adapter dialing a
   * dead listener. The re-mirror commits to the running composition even
   * when the profile patch cannot be persisted. Absent on gateway faces that
   * own no mirror; callers feature-detect before relying on it.
   * @param baseURL - the baseURL the failed request used.
   * @returns whether the request is worth one retry — the stale baseURL named
   *   an origin other than the live one and the re-mirror ran.
   */
  recoverLoopbackRoute?(baseURL: string): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Loopback model-gateway proxy published by this plugin; see {@link GsLlmGateway}. */
    gsLlmGateway: GsLlmGateway
  }
}
