/**
 * Sensitive-skill policy primitives for the gsclaw-server client layer.
 *
 * Pure functions only; no Cordis or network dependencies. Every normalizer
 * fails closed: an absent or unrecognized skill `modelPolicy` is
 * `trusted-only`, an absent or unrecognized provider `trustLevel` is
 * `external`, and an unrecognized `executionLocation` is dropped.
 *
 * @module
 */

/** Skill data-egress policy delivered by the server. */
export type GsSkillModelPolicy = 'standard' | 'trusted-only'

/** One admin-flagged local skill restriction entry. */
export interface GsLocalSkillRestriction {
  readonly name: string
  readonly contentHash: string
}

/** SHA-256 hex shape of a restricted content hash. */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u

/** Skill-name shape mirrored from dsh-skill (kept local to stay Cordis-free). */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * Validate the delivered local-skill restriction list; invalid entries drop
 * out individually instead of poisoning the whole lane.
 * @param value - raw `localSkillRestrictions` payload from the server.
 * @returns the entries whose name and content hash both validate.
 */
export function normalizeLocalSkillRestrictions(value: unknown): GsLocalSkillRestriction[] {
  if (!Array.isArray(value)) return []
  const restrictions: GsLocalSkillRestriction[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const { name, contentHash } = entry as { name?: unknown; contentHash?: unknown }
    if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)
      || typeof contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(contentHash)) continue
    restrictions.push({ name, contentHash })
  }
  return restrictions
}

/** One normalized review request; legacy string entries carry no hash pin. */
export interface GsSkillReviewRequestNormalized {
  readonly name: string
  readonly contentHash?: string
}

/**
 * Normalize the reviewRequests list: object form (`{name, contentHash}`) is
 * current, bare strings survive the transition as a name with no hash pin.
 * @param value - raw `reviewRequests` payload from the server.
 * @returns the entries whose name (and hash, when present) validate.
 */
export function normalizeSkillReviewRequests(value: unknown): GsSkillReviewRequestNormalized[] {
  if (!Array.isArray(value)) return []
  const requests: GsSkillReviewRequestNormalized[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry !== '' && SKILL_NAME_PATTERN.test(entry)) requests.push({ name: entry })
      continue
    }
    if (typeof entry !== 'object' || entry === null) continue
    const { name, contentHash } = entry as { name?: unknown; contentHash?: unknown }
    if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) continue
    if (contentHash !== undefined && (typeof contentHash !== 'string' || !CONTENT_HASH_PATTERN.test(contentHash))) continue
    requests.push({
      name,
      ...(contentHash === undefined ? {} : { contentHash }),
    })
  }
  return requests
}

/** Provider trust classification delivered by the server. */
export type GsProviderTrustLevel = 'trusted' | 'external'

/** Where a provider's inference runs. */
export type GsProviderExecutionLocation = 'local' | 'server'

/** Policy protocol version this client declares on every gsclaw-server request. */
export const GS_POLICY_VERSION = 1

/** Request header carrying {@link GS_POLICY_VERSION}. */
export const GS_POLICY_VERSION_HEADER = 'X-GSClaw-Policy-Version'

/** Header marking traffic of a private (trusted-only) session for audit. */
export const GS_SENSITIVE_SESSION_HEADER = 'x-gsclaw-sensitive'

/** Value sent on {@link GS_SENSITIVE_SESSION_HEADER}. Protocol constant. */
export const GS_SENSITIVE_SESSION_HEADER_VALUE = '1'

/** Policy-class execute error codes; these never warrant a reconstruct retry. */
export const GS_SKILL_POLICY_ERROR_CODES = [
  'skill_requires_trusted_session',
  'skill_policy_unavailable',
  'trusted_provider_unavailable',
  'session_provider_forbidden',
] as const

/** One policy-class execute error code. */
export type GsSkillPolicyErrorCode = (typeof GS_SKILL_POLICY_ERROR_CODES)[number]

/**
 * Whether one execute-endpoint machine code is a policy refusal.
 * @param code - raw error code from either execute envelope.
 * @returns true when the code names a policy refusal.
 */
export function isSkillPolicyErrorCode(code: unknown): code is GsSkillPolicyErrorCode {
  return typeof code === 'string'
    && (GS_SKILL_POLICY_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * Skill policy normalizer; missing or unknown values fail closed.
 * @param value - raw `modelPolicy` payload.
 * @returns the recognized policy, or `trusted-only`.
 */
export function normalizeSkillModelPolicy(value: unknown): GsSkillModelPolicy {
  return value === 'standard' ? 'standard' : 'trusted-only'
}

/**
 * Provider trust normalizer; missing or unknown values fail closed.
 * @param value - raw `trustLevel` payload.
 * @returns the recognized trust level, or `external`.
 */
export function normalizeProviderTrustLevel(value: unknown): GsProviderTrustLevel {
  return value === 'trusted' ? 'trusted' : 'external'
}

/**
 * Execution-location normalizer; unrecognized values carry no information.
 * @param value - raw `executionLocation` payload.
 * @returns the recognized location, or undefined.
 */
export function normalizeExecutionLocation(value: unknown): GsProviderExecutionLocation | undefined {
  return value === 'local' || value === 'server' ? value : undefined
}

/**
 * Declared policy protocol version of one meta `skillExecution` capability;
 * undefined when the server predates the sensitive-skill capability.
 * @param capability - raw `skillExecution` field of the meta handshake.
 * @returns the declared version, or undefined.
 */
export function skillExecutionPolicyVersion(capability: unknown): number | undefined {
  if (typeof capability !== 'object' || capability === null) return undefined
  const value = (capability as { policyVersion?: unknown }).policyVersion
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

/**
 * Effective policy of one catalog entry or definition response. A server that
 * declares the policy capability is held to it fail-closed — an entry missing
 * the field is treated as `trusted-only`; a server without the capability
 * predates classification, so only an explicit `trusted-only` marker gates.
 * @param declared - whether the server declared the policy capability.
 * @param value - raw `modelPolicy` payload of the entry.
 * @returns the policy the client must enforce for the entry.
 */
export function effectiveSkillModelPolicy(declared: boolean, value: unknown): GsSkillModelPolicy {
  if (declared) return normalizeSkillModelPolicy(value)
  return value === 'trusted-only' ? 'trusted-only' : 'standard'
}

/**
 * Effective policy of one raw catalog entry or definition response object.
 * @param value - raw catalog entry or definition response.
 * @param declared - whether the server declared the policy capability.
 * @returns the policy the client must enforce for the entry.
 */
export function skillModelPolicyOf(value: unknown, declared: boolean): GsSkillModelPolicy {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { modelPolicy?: unknown }).modelPolicy
    : undefined
  return effectiveSkillModelPolicy(declared, raw)
}

/** Normalized trust metadata of one `models.providers` entry. */
export interface GsProviderPolicyFields {
  readonly trustLevel: GsProviderTrustLevel
  readonly executionLocation?: GsProviderExecutionLocation
  readonly revision?: string
}

/**
 * Strict trust-metadata extraction of one raw provider entry; fails closed.
 * @param value - raw `models.providers` entry.
 * @returns the normalized trust metadata.
 */
export function providerPolicyFields(value: unknown): GsProviderPolicyFields {
  const record = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const location = normalizeExecutionLocation(record.executionLocation)
  const revision = record.revision
  return {
    trustLevel: normalizeProviderTrustLevel(record.trustLevel),
    ...(location === undefined ? {} : { executionLocation: location }),
    ...(typeof revision === 'string' && revision !== '' ? { revision } : {}),
  }
}
