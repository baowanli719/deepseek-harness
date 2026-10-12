/**
 * Server-pushed model plan for the gsclaw composition.
 *
 * `planGsLlmGatewayModels` turns the ClientConfig `models` section into the
 * `llm-pi-ai` provider profiles that route every Agent-loop LLM call through
 * the loopback proxy (proxy.ts), plus the default model selection for the
 * `agent-default-model` row. The plugin owns the mirrored `providers` section
 * outright: a user edit to it survives only until the next ClientConfig push,
 * and the settings write path hot-reloads, so a mirrored update reaches the
 * running adapter without a restart.
 *
 * The mirrored document carries the credential *reference* only; the per-boot
 * proxy token itself lives in the launch-environment snapshot, never on disk.
 * Every mirrored profile switches on pi-ai's session-affinity emission in the
 * single-header `openrouter` format, so the adapter binds each session-bound
 * request to its session id on the loopback hop — the fact the proxy's
 * audit-header judgement reads.
 *
 * @module dsh-llm-gs-gateway/models
 */

import type { LaunchEnvironmentEntry, LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { GsModelsConfig } from '@deepseek-ai/dsh-gs-server'
import { GS_LLM_GATEWAY_PROVIDER_ID_PATTERN } from './proxy.ts'

/** Credential reference the per-boot proxy token resolves through. */
export const GS_LLM_GATEWAY_CREDENTIAL_REF = 'DSH_GS_LLM_PROXY_TOKEN'

/** Server-managed visual backend; model is an opaque placeholder resolved by the dedicated server endpoint. */
export interface GsVisionRouterSettings {
  readonly httpProviders: readonly {
    readonly name: string
    readonly baseURL: string
    readonly model: string
    readonly apiKeyEnv: string
    readonly maxTokens: number
    readonly maxImageBodyBytes: number
  }[]
  readonly freeFallback: false
  readonly onboardingSeen: true
  readonly desktopToolMode: true
}

/**
 * Configure visual tools through the dedicated gateway; actual model identity and credentials remain server-owned.
 * @param proxyOrigin - live loopback origin of this boot.
 * @param credentialRef - in-memory proxy token reference.
 * @param bounds - deployment-owned output and aggregate image-byte limits.
 * @returns the owned visual-tool settings section.
 */
export function planGsVisionRouterSettings(
  proxyOrigin: string,
  credentialRef: string,
  bounds: { readonly visionMaxTokens: number; readonly visionMaxImageBodyBytes: number },
): GsVisionRouterSettings {
  return {
    httpProviders: [{ name: 'gsclaw-vision', baseURL: `${proxyOrigin}/vision`, model: 'server-vision',
      apiKeyEnv: credentialRef, maxTokens: bounds.visionMaxTokens, maxImageBodyBytes: bounds.visionMaxImageBodyBytes }],
    freeFallback: false, onboardingSeen: true, desktopToolMode: true,
  }
}

/** Model-id guard: ids land in request bodies, never in proxy URLs. */
const MODEL_ID_PATTERN = /^[^\s/\\]{1,256}$/u

/** Request modalities the pi-ai adapter can serve. */
const PI_AI_MODALITIES: ReadonlySet<string> = new Set(['text', 'image'])

/** One model entry inside a mirrored `llm-pi-ai` provider profile. */
export interface GsLlmGatewayProviderModel {
  readonly id: string
  readonly name?: string
  readonly input?: readonly ('text' | 'image')[]
}

/** Mirrored `llm-pi-ai` provider profile routing through the loopback proxy. */
export interface GsLlmGatewayProviderProfile {
  readonly displayName: string
  readonly api: 'openai-completions'
  readonly baseURL: string
  readonly apiKeyEnv: string
  /**
   * Wire-compatibility switches stamped on every mirrored route: pi-ai emits
   * the request's session id as a single `x-session-id` header, which the
   * proxy (proxy.ts) reads to judge the `x-gsclaw-sensitive` audit header.
   * The header travels only on the token-guarded loopback hop and is never
   * forwarded upstream.
   */
  readonly compat: {
    readonly sendSessionAffinityHeaders: true
    readonly sessionAffinityFormat: 'openrouter'
  }
  readonly models: readonly GsLlmGatewayProviderModel[]
}

/** Resolved default model selection for the `agent-default-model` row. */
export interface GsLlmGatewayDefaultModel {
  readonly provider: string
  readonly model: string
}

/** Inputs for {@link planGsLlmGatewayModels}. */
export interface GsLlmGatewayModelPlanInput {
  /** Server ClientConfig `models` section; null or empty keeps local model settings. */
  readonly models: GsModelsConfig | null | undefined
  /** Loopback proxy origin, e.g. `http://127.0.0.1:43123`. */
  readonly proxyOrigin: string
  /** Credential reference naming the proxy token; defaults to {@link GS_LLM_GATEWAY_CREDENTIAL_REF}. */
  readonly credentialRef?: string
}

/** Server-mediated model plan for one mirror generation. */
export interface GsLlmGatewayModelPlan {
  /** `llm-pi-ai` providers dict; undefined when the server supplied nothing usable. */
  readonly providers?: Record<string, GsLlmGatewayProviderProfile>
  /** Default selection resolved from `defaultPrimary` or the first supplied model. */
  readonly defaultModel?: GsLlmGatewayDefaultModel
  /** Human-readable diagnostics for skipped or unresolvable server entries. */
  readonly warnings: readonly string[]
}

/**
 * Build the provider profiles and default selection from the server models
 * section. Provider keys are sorted so the mirrored document is stable across
 * identical pushes; unusable entries are skipped with a warning rather than
 * failing the mirror.
 * @param input - the server models section, the live proxy origin, and the credential reference.
 * @returns the providers dict to mirror, the default selection, and diagnostics.
 */
export function planGsLlmGatewayModels(input: GsLlmGatewayModelPlanInput): GsLlmGatewayModelPlan {
  const warnings: string[] = []
  const source = input.models
  const credentialRef = input.credentialRef ?? GS_LLM_GATEWAY_CREDENTIAL_REF
  if (source === null || source === undefined) {
    warnings.push('server ClientConfig carries no models section; keeping the local model settings')
    return { warnings }
  }
  const providers: Record<string, GsLlmGatewayProviderProfile> = {}
  for (const providerId of Object.keys(source.providers).sort()) {
    const entry = source.providers[providerId]
    if (entry === undefined) continue
    if (!GS_LLM_GATEWAY_PROVIDER_ID_PATTERN.test(providerId)) {
      warnings.push(`server model provider ${JSON.stringify(providerId)} is outside the route grammar; skipped`)
      continue
    }
    const models: GsLlmGatewayProviderModel[] = []
    for (const model of entry.models) {
      if (!MODEL_ID_PATTERN.test(model.id)) {
        warnings.push(`server model ${JSON.stringify(model.id)} of provider ${providerId} is not a usable model id; skipped`)
        continue
      }
      const inputModalities = model.input?.filter((modality): modality is 'text' | 'image' =>
        PI_AI_MODALITIES.has(modality))
      models.push({
        id: model.id,
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(inputModalities === undefined || inputModalities.length === 0
          ? {}
          : { input: inputModalities }),
      })
    }
    if (models.length === 0) {
      warnings.push(`server model provider ${providerId} supplies no usable models; skipped`)
      continue
    }
    providers[providerId] = {
      displayName: providerId,
      api: entry.api,
      baseURL: `${input.proxyOrigin}/v1/${providerId}`,
      apiKeyEnv: credentialRef,
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' },
      models,
    }
  }
  const providerIds = Object.keys(providers)
  if (providerIds.length === 0) {
    warnings.push('server ClientConfig supplied no usable model providers; keeping the local model settings')
    return { warnings }
  }

  let defaultModel: GsLlmGatewayDefaultModel | undefined
  const primary = source.defaultPrimary
  if (primary !== undefined) {
    const slash = primary.indexOf('/')
    const provider = slash === -1 ? primary : primary.slice(0, slash)
    const model = slash === -1 ? '' : primary.slice(slash + 1)
    const route = providers[provider]
    if (route !== undefined && route.models.some(entry => entry.id === model)) {
      defaultModel = { provider, model }
    } else {
      warnings.push(`server defaultPrimary ${JSON.stringify(primary)} does not resolve to a supplied provider/model; using the first supplied model`)
    }
  }
  const firstProvider = providerIds[0]
  const firstModel = firstProvider === undefined ? undefined : providers[firstProvider]?.models[0]
  if (firstProvider === undefined || firstModel === undefined) return { warnings }
  defaultModel ??= { provider: firstProvider, model: firstModel.id }
  return { providers, defaultModel, warnings }
}

/**
 * Launch-environment snapshot carrying the per-boot proxy token as a
 * `process`-layer entry. The token lives only in this in-memory snapshot: it
 * is never written to disk and never materialized into `process.env`, so
 * sandboxed tool subprocesses cannot inherit it, while `ctx.credentials` and
 * the pi-ai adapter's launch-environment fallback both resolve it here.
 * @param base - the launcher's snapshot being wrapped.
 * @param token - the per-boot proxy token.
 * @param credentialRef - reference the token resolves under; defaults to {@link GS_LLM_GATEWAY_CREDENTIAL_REF}.
 * @returns the snapshot to install as `ctx.launchEnvironment`.
 */
export function gsLlmGatewayLaunchEnvironment(
  base: LaunchEnvironmentSnapshot,
  token: string,
  credentialRef: string = GS_LLM_GATEWAY_CREDENTIAL_REF,
): LaunchEnvironmentSnapshot {
  const entry: LaunchEnvironmentEntry = { value: token, source: 'process' }
  return {
    get(name) {
      if (name === credentialRef) return entry
      return base.get(name)
    },
    getFrom(name, sources) {
      if (name === credentialRef) return sources.includes('process') ? entry : undefined
      return base.getFrom(name, sources)
    },
  }
}
