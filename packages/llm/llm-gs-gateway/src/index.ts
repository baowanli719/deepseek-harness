/**
 * gsclaw model-gateway adapter plugin. One mount owns two wired halves:
 *
 * - the loopback proxy (proxy.ts): a 127.0.0.1 random-port HTTP server whose
 *   per-boot placeholder token guards every request and whose forwarding runs
 *   through `gsServer.fetch`, so the real access token, endpoint resolution,
 *   and the single-flight 401 refresh all stay inside `dsh-gs-server`; a
 *   request whose session-id header names a private session forwards with the
 *   `x-gsclaw-sensitive: 1` audit header, judged against the optional
 *   `sensitivePolicy` service;
 * - the model mirror (models.ts): the server ClientConfig `models` section is
 *   planned into `llm-pi-ai` provider profiles pointing at the proxy and
 *   written through the settings service, whose volatile commit reaches the
 *   running adapter without a restart; the server default model lands in the
 *   `agent-default-model` row. Mirrored profiles switch on pi-ai's
 *   session-affinity emission, which is what binds each adapter request to
 *   its session on the loopback hop. Both namespaces are owned outright —
 *   user edits survive only until the next ClientConfig push.
 *
 * The composition mounts `llm-pi-ai` (dormant: no configured providers) and
 * `agent-default-model` under the namespaces named here, and installs the
 * per-boot token into the launch-environment snapshot under
 * `credentialRef` — either before mounting this plugin (the plugin then
 * adopts that token) or afterwards via {@link gsLlmGatewayLaunchEnvironment}
 * and the published `gsLlmGateway` service.
 *
 * @module @deepseek-ai/dsh-llm-gs-gateway
 */
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-config-editor'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { GsClientConfig } from '@deepseek-ai/dsh-gs-server'
// Type-only: pulls the `Context.sensitivePolicy` service declaration in; the
// service itself is resolved optionally at runtime through `ctx.get`.
import type {} from '@deepseek-ai/dsh-sensitive-policy'
import { GsLlmGatewayProxy } from './proxy.ts'
import { GS_LLM_GATEWAY_CREDENTIAL_REF, planGsLlmGatewayModels, planGsVisionRouterSettings } from './models.ts'

export * from './types.ts'
export {
  createGsLlmGatewayToken,
  GS_LLM_GATEWAY_PROVIDER_ID_PATTERN,
  GS_LLM_GATEWAY_SESSION_ID_HEADER,
  GsLlmGatewayProxy,
  isGsLlmGatewayLoopbackAddress,
} from './proxy.ts'
export type { GsLlmGatewayProxyOptions } from './proxy.ts'
export {
  GS_LLM_GATEWAY_CREDENTIAL_REF,
  gsLlmGatewayLaunchEnvironment,
  planGsLlmGatewayModels,
  planGsVisionRouterSettings,
} from './models.ts'
export type {
  GsLlmGatewayDefaultModel,
  GsLlmGatewayModelPlan,
  GsLlmGatewayModelPlanInput,
  GsLlmGatewayProviderModel,
  GsLlmGatewayProviderProfile,
  GsVisionRouterSettings,
} from './models.ts'

const BIN_NAME = 'llm-gs-gateway'

/** Plugin configuration: deployment-owned names and bounds of the gateway adapter. */
export interface Config {
  /** Settings namespace (profile entry id) of the dormant `llm-pi-ai` mount the mirror owns (default `llm-pi-ai`). */
  providerNamespace: string
  /** Settings namespace of the `agent-default-model` mount receiving the server default model (default `agent-default-model`). */
  defaultModelNamespace: string
  /** Optional managed Vision Router settings namespace; empty leaves visual tools unconfigured. */
  visionRouterNamespace: string
  /** Maximum answer tokens for the managed visual backend. */
  visionMaxTokens: number
  /** Aggregate inline-image raw-byte budget, leaving headroom under the proxy body limit. */
  visionMaxImageBodyBytes: number
  /** Credential reference the per-boot proxy token resolves through (default `DSH_GS_LLM_PROXY_TOKEN`). */
  credentialRef: string
  /** Maximum chat-completions request body the proxy accepts (default 4 MiB). */
  maxBodyBytes: number
}

export const Config = z.object({
  providerNamespace: z.string().default('llm-pi-ai'),
  defaultModelNamespace: z.string().default('agent-default-model'),
  visionRouterNamespace: z.string().default(''),
  visionMaxTokens: z.number().step(1).min(1).default(4096),
  visionMaxImageBodyBytes: z.number().step(1).min(1).default(2800000),
  credentialRef: z.string().default(GS_LLM_GATEWAY_CREDENTIAL_REF),
  maxBodyBytes: z.number().step(1).min(1).default(4 * 1024 * 1024),
})

export const name = BIN_NAME
export const inject = ['gsServer', 'settings']

/**
 * Start the loopback proxy, publish `gsLlmGateway`, and mirror the server
 * model plan into the configured settings namespaces — after Loader activation
 * from the cached ClientConfig when a session predates this mount, then on every
 * `gs-server/session-established` and `gs-server/client-config-changed`.
 * @param ctx - plugin lifetime with `gsServer` and `settings` injected.
 * @param config - validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // A composition may mint the token itself and install it before this plugin
  // mounts; adopting it keeps the proxy and the adapter credential resolver on
  // the same value. Otherwise the token exists only here until the composition
  // wires it into the launch environment through the published service.
  const inherited = launchEnvironmentOf(ctx).get(config.credentialRef)?.value
  const proxy = new GsLlmGatewayProxy({
    ...inherited === undefined ? {} : { token: inherited },
    maxBodyBytes: config.maxBodyBytes,
    accessToken: () => ctx.gsServer.getAccessToken(),
    upstream: (path, init) => ctx.gsServer.fetch(path, init),
    // Optional service: a composition without sensitive-policy emits no audit
    // header, which is exactly that composition's policy surface.
    isPrivateSession: sessionId => ctx.get('sensitivePolicy')?.isPrivate(sessionId) ?? false,
    onError: (line) => { ctx.logger.warn('%s', line) },
  })
  await proxy.start()
  ctx.effect(() => () => proxy.close())
  ctx.provide('gsLlmGateway', proxy)

  /** Fingerprint of the last committed mirror; identical pushes never touch settings. */
  let lastMirror: string | undefined
  const mirror = async (clientConfig: GsClientConfig): Promise<void> => {
    const plan = planGsLlmGatewayModels({
      models: clientConfig.models,
      proxyOrigin: proxy.origin,
      credentialRef: config.credentialRef,
    })
    for (const warning of plan.warnings) ctx.logger.warn('%s: %s', BIN_NAME, warning)
    const visionRouter = config.visionRouterNamespace === '' ? undefined
      : planGsVisionRouterSettings(proxy.origin, config.credentialRef, config)
    const fingerprint = JSON.stringify([plan.providers ?? null, plan.defaultModel ?? null, visionRouter ?? null])
    if (fingerprint === lastMirror) return
    // The mirror owns both namespaces outright: the providers dict replaces
    // the whole volatile section, and the default-model row follows the
    // server selection while leaving the user's reasoning effort untouched.
    if (plan.providers !== undefined) {
      await ctx.settings.replace(config.providerNamespace, { providers: plan.providers })
    }
    if (plan.defaultModel !== undefined) {
      await ctx.settings.mutate(config.defaultModelNamespace, [
        { op: 'set', path: ['provider'], value: plan.defaultModel.provider },
        { op: 'set', path: ['model'], value: plan.defaultModel.model },
      ])
    }
    if (visionRouter !== undefined) {
      const editor = ctx.get('configEditor')
      if (editor === undefined) throw new Error('llm-gs-gateway: managed visual tools require configEditor')
      const entry = editor.entries().find(row => row.options.id === config.visionRouterNamespace)
      if (entry === undefined) throw new Error(`llm-gs-gateway: missing visual-tool entry ${config.visionRouterNamespace}`)
      await editor.edit(entry, current => ({ ...current, ...visionRouter }))
    }
    lastMirror = fingerprint
  }
  const mirrorLogged = (clientConfig: GsClientConfig): void => {
    void mirror(clientConfig).catch((error: unknown) => {
      ctx.logger.error(`${BIN_NAME}: mirroring the server model plan failed`)
      ctx.logger.error(error)
    })
  }

  // ConfigEditor reconciliation awaits every Loader fiber, including this
  // mount. A restored plan must therefore be written after activation.
  const loader = ctx.root.get('loader')
  if (loader === undefined) {
    const initial = ctx.gsServer.getClientConfig()
    if (initial !== undefined) await mirror(initial)
  } else {
    ctx.effect(() => {
      let disposed = false
      void loader.await().then(() => {
        if (disposed) return
        const initial = ctx.gsServer.getClientConfig()
        if (initial !== undefined) mirrorLogged(initial)
      }).catch((error: unknown) => { if (!disposed) ctx.logger.error(error) })
      return () => { disposed = true }
    })
  }

  ctx.on('gs-server/session-established', () => {
    const current = ctx.gsServer.getClientConfig()
    if (current !== undefined) mirrorLogged(current)
  })
  ctx.on('gs-server/client-config-changed', mirrorLogged)
}
