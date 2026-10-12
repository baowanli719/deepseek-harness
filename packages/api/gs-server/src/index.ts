/**
 * gsclaw-server integration plugin: authentication token state machine,
 * authenticated HTTP client, endpoint resolution, server-driven ClientConfig
 * cache, brand store, private host routes, and log export.
 *
 * The plugin provides the `gsServer` Cordis service. Access tokens stay in
 * process memory; the rotating refresh token is sealed through the configured
 * {@link GsRefreshTokenProtector} before it touches the disk, and hosts on
 * platforms without an OS-backed protector must inject one through Config —
 * the service never falls back to plaintext persistence.
 *
 * @module @deepseek-ai/dsh-gs-server
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  GsAuthService,
  gsClientPlatform,
  type GsAuthSnapshot,
  type GsClientIdentity,
  type GsEmailLogin,
  type GsPasswordLogin,
} from './auth.ts'
import { GsBrandStore } from './brand.ts'
import { authorizedFetch, authorizedJson, type GsRequest } from './client.ts'
import { GsClientConfigCache, type GsClientConfigSnapshot } from './config.ts'
import type {
  GsAuthMethods,
  GsAuthUser,
  GsBrandView,
  GsCaptcha,
  GsClientConfig,
  GsEmailCodeResponse,
  GsModelRiskDownloadRequest,
  GsModelRiskDownloadResponse,
  GsModelRiskSignRequest,
  GsModelRiskStatusRequest,
  GsModelRiskView,
  GsServerMetaView,
  GsSessionView,
  GsTokenPair,
} from './contract.ts'
import { GS_DEFAULT_ENDPOINT, GsEndpointStore } from './endpoint.ts'
import { GsLogExporter } from './log-exporter.ts'
import type { LogLevel } from './log-level.ts'
import { resolvePlatformProtector, type GsRefreshTokenProtector } from './protector.ts'
import { createGsServerRoutes } from './routes.ts'

export * from './auth.ts'
export * from './brand.ts'
export * from './client.ts'
export * from './config.ts'
export * from './contract.ts'
export * from './endpoint.ts'
export * from './log-exporter.ts'
export * from './log-level.ts'
export * from './loopback.ts'
export * from './mask-secrets.ts'
export * from './policy.ts'
export * from './protector.ts'
export * from './routes.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-owned gsclaw-server client: endpoint, auth, ClientConfig cache, brand, log upload. */
    gsServer: GsServer
  }
  interface Events {
    /**
     * Local authentication ended through logout or an endpoint change.
     * @mode emit
     */
    'gs-server/session-ended'(): void
    /**
     * A gsclaw-server session became live: password/email login, host token
     * adoption, restart restore, or a token refresh.
     * @mode emit
     * @param user - authenticated user the established session belongs to.
     */
    'gs-server/session-established'(user: GsAuthUser): void
    /**
     * The server rejected the refresh token as expired (401); local credential
     * state was wiped. A user-initiated logout does not fire this event.
     * @mode emit
     */
    'gs-server/session-expired'(): void
    /**
     * The server revoked the credential family (403: account disabled or trust
     * withdrawn); local credential state was wiped.
     * @mode emit
     */
    'gs-server/trust-revoked'(): void
    /**
     * The cached server ClientConfig changed, by login/refresh push or by an
     * active `refreshClientConfig()` pull.
     * @mode emit
     * @param config - the new effective ClientConfig.
     */
    'gs-server/client-config-changed'(config: GsClientConfig): void
  }
}

/** Deployment and host choices for the gsclaw-server client. */
export interface Config {
  /** Absolute directory holding endpoint, credential, and brand state. */
  readonly stateDir: string
  /** Deployment default endpoint; the persisted override and the GSCLAW_ENDPOINT environment seam win over it. */
  readonly endpoint?: string
  /** Environment endpoint override; defaults to the GSCLAW_ENDPOINT variable. */
  readonly environment?: string
  /** Client version reported to the gateway inside login and refresh bodies. */
  readonly clientVersion: string
  /** Client platform reported to the gateway; defaults to the running OS. */
  readonly clientPlatform?: GsClientIdentity['platform']
  /**
   * Refresh-token protector. Defaults to Windows DPAPI or macOS Keychain-backed
   * AES-GCM; other platforms require an injected OS-backed implementation.
   */
  readonly protector?: GsRefreshTokenProtector
  /**
   * Register the private `/api/gs-server/*` routes on the Host webServer.
   * Requires the `webServer` service when enabled; the service fails to start
   * otherwise.
   */
  readonly routes?: boolean
  /** Restore an OS-sealed refresh token before the Desktop startup gate reads session state. */
  readonly restoreOnStart?: boolean
  /** Authentication and ClientConfig request deadline in milliseconds; model streams retain caller cancellation. */
  readonly authRequestTimeoutMs?: number
  /** Upload rendered, secret-masked client logs to `POST /api/logs/client`. */
  readonly logUpload?: boolean
  /** Verbosity threshold of the log uploader. */
  readonly logLevel?: LogLevel
  /** Fetch implementation override for host adapters and tests. */
  readonly request?: GsRequest
}

export const Config: z<Config> = z.object({
  stateDir: z.string().required(),
  endpoint: z.string().default(GS_DEFAULT_ENDPOINT),
  environment: z.string(),
  clientVersion: z.string().required(),
  clientPlatform: z.union([z.const('windows'), z.const('macos'), z.const('linux')]),
  protector: z.any(),
  routes: z.boolean().default(true),
  restoreOnStart: z.boolean().default(false),
  authRequestTimeoutMs: z.number().min(1).default(15_000),
  logUpload: z.boolean().default(false),
  logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default('info'),
  request: z.any(),
})

/** Response byte cap for model-risk sign/download; the download payload is a base64 PDF. */
const MAX_MODEL_RISK_RESPONSE_BYTES = 8 * 1024 * 1024

/**
 * Host-owned gsclaw-server client service. Composes the endpoint store, the
 * authentication state machine, the ClientConfig cache, and the brand store,
 * and optionally mounts the private loopback routes and the log uploader.
 */
export class GsServer extends Service {
  static Config: z<Config> = Config

  /** Endpoint store backing every request; assigned at service init. */
  endpoints!: GsEndpointStore
  /** Authentication state machine; assigned at service init. */
  auth!: GsAuthService
  /** ClientConfig cache; assigned at service init. */
  config!: GsClientConfigCache
  /** Brand store; assigned at service init. */
  brand!: GsBrandStore

  private readonly resolved: Config
  private readonly protector: GsRefreshTokenProtector

  /**
   * @param ctx - Host context the service registers on.
   * @param config - deployment options; validated by the static Config schema,
   *   which rejects a missing stateDir or clientVersion at load.
   */
  constructor(ctx: Context, config?: Config) {
    super(ctx, 'gsServer')
    this.resolved = Config(config)
    this.protector = this.resolved.protector ?? resolvePlatformProtector()
  }

  /** Load persisted endpoint and brand state, compose the client layer, and mount opt-in surfaces. */
  async [Service.init](): Promise<void> {
    const resolved = this.resolved
    const request: GsRequest = (url, init) => {
      const deadline = AbortSignal.timeout(resolved.authRequestTimeoutMs ?? 15_000)
      return (resolved.request ?? globalThis.fetch)(url, {
        ...init,
        signal: init.signal == null ? deadline : AbortSignal.any([init.signal, deadline]),
      })
    }
    const endpoints = await GsEndpointStore.load({
      stateDir: resolved.stateDir,
      ...(resolved.environment === undefined ? {} : { environment: resolved.environment }),
      fallback: resolved.endpoint ?? GS_DEFAULT_ENDPOINT,
    })
    const brand = await GsBrandStore.load({ stateDir: resolved.stateDir })
    // The auth callbacks and the cache reference each other; the cell breaks
    // the construction cycle.
    const cacheCell: { current?: GsClientConfigCache } = {}
    const auth = new GsAuthService({
      endpoint: () => endpoints.resolve(),
      stateDir: resolved.stateDir,
      protector: this.protector,
      client: {
        platform: resolved.clientPlatform ?? gsClientPlatform(process.platform),
        version: resolved.clientVersion,
      },
      request,
      onConfig: (user, next) => { cacheCell.current?.update(user, next) },
      onSessionEstablished: (user) => { this.ctx.emit('gs-server/session-established', user) },
      onSessionLost: (reason) => {
        cacheCell.current?.clear()
        this.ctx.emit(reason === 'disabled' ? 'gs-server/trust-revoked' : 'gs-server/session-expired')
      },
    })
    const config = new GsClientConfigCache({
      endpoint: () => endpoints.resolve(),
      session: auth,
      request,
    })
    cacheCell.current = config
    // Every ClientConfig push refreshes the brand store; a persist failure
    // only loses the offline cache, so it never faults the push path.
    config.subscribe((snapshot) => {
      void brand.applyServerBrand(snapshot?.config.brand).catch(() => {})
      if (snapshot !== undefined) this.ctx.emit('gs-server/client-config-changed', snapshot.config)
    })
    this.endpoints = endpoints
    this.auth = auth
    this.config = config
    this.brand = brand

    if (resolved.restoreOnStart) {
      // An outage must keep the sealed token for the next launch. Desktop then
      // opens the password/email-code form, which displays its own offline state.
      await auth.restoreSession().catch((cause: unknown) => {
        this.ctx.logger('gs-server').warn(`session restore failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
    }

    if (resolved.routes) {
      const webServer = this.ctx.get('webServer')
      if (webServer === undefined) {
        throw new Error('dsh-gs-server: Config.routes requires the webServer service; '
          + 'compose @deepseek-ai/dsh-host-webserver before this plugin or set routes: false')
      }
      const reportError = (operation: string, cause: unknown): void => {
        this.ctx.logger('gs-server').warn(`${operation}: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
      for (const route of createGsServerRoutes({
        service: this,
        expectedOrigin: () => `http://127.0.0.1:${String(webServer.port)}`,
        reportError,
      })) {
        this.ctx.effect(() => webServer.register(route), `gs-server: ${route.path}`)
      }
    }

    if (resolved.logUpload) {
      const exporter = new GsLogExporter({
        endpoint: () => endpoints.resolve(),
        session: auth,
        ...(resolved.request === undefined ? {} : { request: resolved.request }),
        ...(resolved.logLevel === undefined ? {} : { threshold: resolved.logLevel }),
      })
      this.ctx.logger.exporter(exporter)
      this.ctx.effect(() => () => exporter.close(), 'gs-server: log upload close')
    }
  }

  /**
   * Current real access token, held only in memory; undefined while signed out.
   * @returns the in-memory access token, or undefined.
   */
  getAccessToken(): Promise<string | undefined> {
    return Promise.resolve(this.auth.accessToken())
  }

  /**
   * Authenticated request against the resolved gsclaw endpoint: attaches the
   * Bearer token and the policy-version header, and on an expired-token 401
   * runs one single-flight refresh before retrying exactly once. The response
   * is returned verbatim; transport failures and the signed-out state reject
   * with GatewayError.
   * @param path - absolute API path beginning with `/`.
   * @param init - fetch init carried verbatim; its headers merge under the credential headers.
   * @returns the gateway response after at most one refresh retry.
   */
  fetch(path: string, init?: RequestInit): Promise<Response> {
    return authorizedFetch({
      endpoint: this.endpoints.resolve(),
      path,
      session: this.auth,
      ...(init === undefined ? {} : { init }),
      ...(this.resolved.request === undefined ? {} : { request: this.resolved.request }),
    })
  }

  /**
   * Latest cached server ClientConfig, or undefined before the first login/refresh.
   * @returns the cached ClientConfig, or undefined.
   */
  getClientConfig(): GsClientConfig | undefined {
    return this.config.snapshot()?.config
  }

  /**
   * Actively pull `/api/client-config` and update the cache.
   * @returns the fresh user + config snapshot.
   */
  refreshClientConfig(): Promise<GsClientConfigSnapshot> {
    return this.config.getClientConfig()
  }

  /**
   * Token-free session view for UI projections.
   * @returns the session view; tokens are never exposed.
   */
  sessionView(): GsSessionView {
    return { endpoint: this.endpoints.resolve(), ...this.auth.snapshot() }
  }

  /**
   * Live server handshake against the effective endpoint; doubles as the pre-login brand channel.
   * @returns the effective endpoint plus the server metadata.
   */
  async getMeta(): Promise<GsServerMetaView> {
    const meta = await this.auth.getMeta()
    if (meta.brand !== undefined) {
      await this.brand.applyServerBrand(meta.brand).catch(() => {})
    }
    return { endpoint: this.endpoints.resolve(), meta }
  }

  /**
   * Enabled login methods; never requires a session.
   * @returns the login-method switches.
   */
  getAuthMethods(): Promise<GsAuthMethods> {
    return this.auth.getAuthMethods()
  }

  /**
   * One-time graphical captcha; null when the server predates captchas.
   * @returns the captcha, or null on a legacy server.
   */
  fetchCaptcha(): Promise<GsCaptcha | null> {
    return this.auth.fetchCaptcha()
  }

  /**
   * Password login; resolves with the fresh session view.
   * @param login - credentials plus the solved captcha when the server asked for one.
   * @returns the token-free session view after login.
   */
  async loginWithPassword(login: GsPasswordLogin): Promise<GsSessionView> {
    await this.auth.loginWithPassword(login)
    return this.sessionView()
  }

  /**
   * Send one email verification code to the account's registered address.
   * @param account - account name or email accepted by the gateway.
   * @returns the send-code outcome with second-normalized windows.
   */
  sendEmailCode(account: string): Promise<GsEmailCodeResponse> {
    return this.auth.sendEmailCode(account)
  }

  /**
   * Email-code login; resolves with the fresh session view.
   * @param login - account plus the received verification code.
   * @returns the token-free session view after login.
   */
  async loginWithEmailCode(login: GsEmailLogin): Promise<GsSessionView> {
    await this.auth.loginWithEmailCode(login)
    return this.sessionView()
  }

  /**
   * Host token-write entry for login surfaces this package does not ship
   * (SSO, QR, or a native login window): adopt a gateway-issued token pair,
   * sealing and persisting the refresh token exactly like a password login.
   * @param tokens - rotating token pair issued by the gateway.
   * @param user - authenticated user projection paired with the tokens.
   * @param config - ClientConfig delivered alongside the tokens.
   * @returns the token-free snapshot after adoption.
   */
  adoptTokens(tokens: GsTokenPair, user: GsAuthUser, config: GsClientConfig): Promise<GsAuthSnapshot> {
    return this.auth.adoptTokens(tokens, user, config)
  }

  /**
   * Restore the persisted session after a restart, single-flight.
   * @returns true when a session is live after the call.
   */
  restoreSession(): Promise<boolean> {
    return this.auth.restoreSession()
  }

  /**
   * Revoke the session family server-side on a best effort, then wipe all local credential state.
   * @returns the token-free snapshot after logout.
   */
  async logout(): Promise<GsAuthSnapshot> {
    const logout = this.auth.logout()
    this.config.clear()
    this.ctx.emit('gs-server/session-ended')
    await logout
    return this.auth.snapshot()
  }

  /**
   * UI-safe view of the effective brand.
   * @returns the frozen brand view.
   */
  brandView(): GsBrandView {
    return this.brand.view()
  }

  /**
   * Fetch the model-risk disclosure status of one provider/model pair; the
   * caller blocks model use on `required` until a signature lands.
   * @param request - provider and model identifiers.
   * @returns the disclosure view; `consentId` and `mailStatus` appear after signing.
   */
  modelRiskStatus(request: GsModelRiskStatusRequest): Promise<GsModelRiskView> {
    return authorizedJson({
      endpoint: this.endpoints.resolve(),
      path: '/api/v1/model-risk/status',
      body: request,
      session: this.auth,
      ...(this.resolved.request === undefined ? {} : { request: this.resolved.request }),
    })
  }

  /**
   * Record one signed disclosure acknowledgment. The body carries signature
   * strokes; the gateway resolves the signer identity from the authenticated account
   * and is never logged.
   * @param request - signed acknowledgment echoing the status revision.
   * @returns the disclosure view after signing, including the consent id.
   */
  modelRiskSign(request: GsModelRiskSignRequest): Promise<GsModelRiskView> {
    return authorizedJson({
      endpoint: this.endpoints.resolve(),
      path: '/api/v1/model-risk/sign',
      body: request,
      session: this.auth,
      maxBytes: MAX_MODEL_RISK_RESPONSE_BYTES,
      ...(this.resolved.request === undefined ? {} : { request: this.resolved.request }),
    })
  }

  /**
   * Download the signed disclosure PDF of one consent record.
   * @param request - consent id returned by the sign call.
   * @returns the base64-encoded PDF.
   */
  modelRiskDownload(request: GsModelRiskDownloadRequest): Promise<GsModelRiskDownloadResponse> {
    return authorizedJson({
      endpoint: this.endpoints.resolve(),
      path: '/api/v1/model-risk/download',
      body: request,
      session: this.auth,
      maxBytes: MAX_MODEL_RISK_RESPONSE_BYTES,
      ...(this.resolved.request === undefined ? {} : { request: this.resolved.request }),
    })
  }

  /**
   * Validate and persist one runtime endpoint override.
   * @param value - new endpoint URL.
   * @returns the normalized persisted endpoint.
   */
  async setEndpointOverride(value: string): Promise<string> {
    await this.logout()
    return this.endpoints.setOverride(value)
  }

  /** Drop the runtime endpoint override so environment and configured default apply again. */
  async clearEndpointOverride(): Promise<void> {
    await this.logout()
    await this.endpoints.clearOverride()
  }

  /** Explicit runtime endpoint override currently persisted, if any. */
  get persistedEndpointOverride(): string | undefined {
    return this.endpoints.persistedOverride
  }
}

export default GsServer
