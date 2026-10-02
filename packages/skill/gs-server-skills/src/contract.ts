/**
 * Wire contract and policy primitives for the gsclaw-server skill-execution
 * protocol (`/api/v1/skills/*`), ported from the gs-worker desktop client.
 *
 * Every normalizer fails closed: an absent or unrecognized skill
 * `modelPolicy` is `trusted-only` once the server declares the policy
 * capability, and malformed restriction entries drop out individually instead
 * of poisoning the whole lane.
 *
 * @module dsh-gs-server-skills/contract
 */

/** Runtime types this package bridges to server-side execution. */
export const GS_SERVER_RUNTIME_TYPES = ['data-query', 'server-mcp'] as const

/** One executable server runtime type. */
export type GsServerRuntimeType = (typeof GS_SERVER_RUNTIME_TYPES)[number]

/** Skill data-egress policy delivered by the server. */
export type GsSkillModelPolicy = 'standard' | 'trusted-only'

/** Server skill-execution capability advertised by `GET /api/v1/meta`. */
export interface GsSkillExecutionCapability {
  readonly version: number
  /** Executable runtime types the server bridges; currently `data-query` and `server-mcp`. */
  readonly types: readonly string[]
  /** Sensitive-skill policy protocol version; absent on servers without the capability. */
  readonly policyVersion?: number
}

/** The slice of the `GET /api/v1/meta` handshake this package consumes. */
export interface GsServerMeta {
  /** Server skill-execution protocol; absent on servers that predate the field. */
  readonly skillExecution?: GsSkillExecutionCapability | null
}

/** One skill summary from `GET /api/v1/skills/catalog`; the server pre-filters visibility. */
export interface GsSkillCatalogEntry {
  /** Initial activation; omitted preserves legacy default-on behavior. */
  readonly defaultEnabled?: boolean
  readonly name: string
  readonly displayName: string
  readonly description: string
  readonly version: string
  readonly runtimeType: string
  /** Opaque revision the execute request must echo back. */
  readonly definitionRevision: string
  /** Data-egress policy; only present when the client declares the policy capability. */
  readonly modelPolicy?: 'standard' | 'trusted-only'
}

/** Success body of `GET /api/v1/skills/catalog`. */
export interface GsSkillCatalogResponse {
  readonly skills: readonly GsSkillCatalogEntry[]
}

/** One declared query-template parameter of a data-query skill. */
export interface GsSkillQueryParam {
  readonly name: string
  readonly type: string
  readonly required: boolean
  readonly enum?: readonly string[]
  readonly description?: string
}

/** Non-sensitive data-query definition: template names and parameter shapes only. */
export interface GsSkillDataQueryDefinition {
  readonly queries: readonly {
    readonly name: string
    readonly description?: string
    readonly params: readonly GsSkillQueryParam[]
  }[]
}

/** One allowlisted MCP tool schema of a server-mcp skill. */
export interface GsSkillMcpTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
}

/** Success body of `GET /api/v1/skills/:name/definition`. */
export interface GsSkillDefinitionResponse {
  readonly name: string
  readonly version: string
  readonly runtimeType: string
  readonly definitionRevision: string
  /** SKILL.md body with the frontmatter already stripped by the server. */
  readonly content: string
  readonly dataQuery?: GsSkillDataQueryDefinition
  readonly mcp?: { readonly tools: readonly GsSkillMcpTool[] }
  /** Data-egress policy; only present when the client declares the policy capability. */
  readonly modelPolicy?: 'standard' | 'trusted-only'
}

/** Request body of `POST /api/v1/skills/:name/execute`. */
export interface GsSkillExecuteRequest {
  readonly requestId: string
  readonly sessionId?: string
  readonly definitionRevision: string
  /** data-query: `{ query, params }`; server-mcp: `{ tool, arguments }`. */
  readonly arguments: Record<string, unknown>
}

/** One text block of an execute result. */
export interface GsSkillExecuteContentBlock {
  readonly type: 'text'
  readonly text: string
}

/**
 * Body of `POST /api/v1/skills/:name/execute`. Business failures keep HTTP 200
 * with `status: 'error'`; authentication, validation, and concurrency failures
 * use the HTTP `{ code, message, traceId }` envelope.
 */
export interface GsSkillExecuteResponse {
  readonly requestId: string
  readonly traceId: string
  readonly status: 'ok' | 'error'
  readonly content?: readonly GsSkillExecuteContentBlock[]
  readonly truncated?: boolean
  readonly error?: { readonly code: string; readonly message?: string }
}

/** One admin-flagged local skill restriction: trusted-only for exact content. */
export interface GsLocalSkillRestriction {
  readonly name: string
  /** SHA-256 hex of the restricted raw SKILL.md content. */
  readonly contentHash: string
}

/** SHA-256 hex shape of a restricted content hash. */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/u

/** Skill-name shape mirrored from dsh-skill (kept local to stay Cordis-free). */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/**
 * Validate the delivered local-skill restriction list; invalid entries drop
 * out individually instead of poisoning the whole lane.
 * @param value - raw `ClientConfig.localSkillRestrictions` value.
 * @returns the entries carrying a valid skill name and SHA-256 hex hash.
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
 * @param code - machine code from the execute response or the HTTP envelope.
 * @returns whether the code belongs to the policy-refusal class.
 */
export function isSkillPolicyErrorCode(code: unknown): code is GsSkillPolicyErrorCode {
  return typeof code === 'string'
    && (GS_SKILL_POLICY_ERROR_CODES as readonly string[]).includes(code)
}

/** Skill policy normalizer; missing or unknown values fail closed. */
function normalizeSkillModelPolicy(value: unknown): GsSkillModelPolicy {
  return value === 'standard' ? 'standard' : 'trusted-only'
}

/**
 * Declared policy protocol version of one meta `skillExecution` capability;
 * undefined when the server predates the sensitive-skill capability.
 * @param capability - raw `skillExecution` field of the meta handshake.
 * @returns the declared policy version, or undefined.
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
 * @param declared - whether the server advertised a policy protocol version.
 * @param value - raw `modelPolicy` field of the entry or definition.
 * @returns the effective data-egress policy.
 */
export function effectiveSkillModelPolicy(declared: boolean, value: unknown): GsSkillModelPolicy {
  if (declared) return normalizeSkillModelPolicy(value)
  return value === 'trusted-only' ? 'trusted-only' : 'standard'
}
