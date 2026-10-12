/**
 * Trust resolution for sensitive-session policy.
 *
 * Trust metadata arrives from gsclaw-server's ClientConfig; every lookup fails
 * closed — an unknown provider, a missing models section, or an absent cached
 * config all resolve to `external`.
 *
 * The `x-gsclaw-sensitive` audit header reaches the wire at the gsclaw
 * model-gateway proxy (`@deepseek-ai/dsh-llm-gs-gateway`): the adapter's
 * session-affinity header binds each loopback request to its session, and the
 * proxy re-judges that session against this plugin's `sensitivePolicy` view —
 * the same core the `llm/stream` wrapper commits — so marked-at-judgement and
 * emitted-on-the-wire can never diverge.
 *
 * @module @deepseek-ai/dsh-sensitive-policy/trust
 */

import type { GsClientConfig, GsSkillPolicyErrorCode } from '@deepseek-ai/dsh-gs-server'
import { normalizeProviderTrustLevel } from '@deepseek-ai/dsh-gs-server'
import type { GsProviderTrustLevel } from '@deepseek-ai/dsh-gs-server'

export { GS_SENSITIVE_SESSION_HEADER, GS_SENSITIVE_SESSION_HEADER_VALUE } from '@deepseek-ai/dsh-gs-server'
export type { GsProviderTrustLevel } from '@deepseek-ai/dsh-gs-server'

/**
 * Failure code of a private session's request refused for resolving to an
 * untrusted provider route. Part of the server-side policy-error vocabulary
 * (`GS_SKILL_POLICY_ERROR_CODES`), so retry policy can route it as a
 * permanent refusal.
 */
export const SENSITIVE_PROVIDER_FORBIDDEN: GsSkillPolicyErrorCode = 'session_provider_forbidden'

/**
 * Resolve one provider's trust level under a cached ClientConfig.
 * @param config - the latest cached server ClientConfig, when any.
 * @param provider - the provider route id as the request spells it.
 * @returns `trusted` only when the config explicitly says so.
 */
export function resolveProviderTrust(
  config: GsClientConfig | undefined,
  provider: string,
): GsProviderTrustLevel {
  return normalizeProviderTrustLevel(config?.models?.providers[provider]?.trustLevel)
}

/**
 * Whether one provider route is trusted under a cached ClientConfig.
 * @param config - the latest cached server ClientConfig, when any.
 * @param provider - the provider route id as the request spells it.
 * @returns whether the route is explicitly trusted.
 */
export function isTrustedProvider(config: GsClientConfig | undefined, provider: string): boolean {
  return resolveProviderTrust(config, provider) === 'trusted'
}
