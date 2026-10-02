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
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Loopback model-gateway proxy published by this plugin; see {@link GsLlmGateway}. */
    gsLlmGateway: GsLlmGateway
  }
}
