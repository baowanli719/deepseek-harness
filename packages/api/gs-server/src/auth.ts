/**
 * gsclaw-server authentication state machine.
 *
 * Access tokens live only in process memory. Refresh tokens are rotating,
 * single-use credentials: they are sealed through the configured
 * {@link GsRefreshTokenProtector} and kept in `gs-refresh-token.bin` below the
 * state directory, and every refresh writes the rotated successor back before
 * the new session is considered live. All refreshes funnel through one
 * single-flight promise because the server treats a concurrent refresh as
 * token replay and revokes the whole family.
 *
 * @module
 */

import { lstat, open, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  GatewayError,
  gsJsonRequest,
  type GsRequest,
  type GsSessionTokenSource,
} from './client.ts'
import type {
  GsAuthMethods,
  GsAuthUser,
  GsCaptcha,
  GsClientConfig,
  GsEmailCodeResponse,
  GsLoginResponse,
  GsRefreshResponse,
  GsServerMeta,
  GsTokenPair,
} from './contract.ts'
import type { GsRefreshTokenProtector } from './protector.ts'

/** Refresh-token state file below the state directory. */
export const GS_REFRESH_TOKEN_FILENAME = 'gs-refresh-token.bin'

/** Maximum sealed token bytes read before treating the file as corrupt. */
export const MAX_GS_REFRESH_TOKEN_BYTES = 8 * 1024

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

/** Resend/expire windows beyond one hour are millisecond payloads, not seconds. */
const EMAIL_CODE_SECONDS_CEILING = 3600

/**
 * Coerce one send-code window to whole seconds; oversized values are milliseconds.
 * @param value - raw `expiresIn`/`resendIn` payload.
 * @returns the window in whole seconds.
 */
export function emailCodeWindowSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.ceil(value > EMAIL_CODE_SECONDS_CEILING ? value / 1000 : value)
}

/** Client identity reported to the gateway inside login and refresh bodies. */
export interface GsClientIdentity {
  /** Operating system the client runs on. */
  readonly platform: 'windows' | 'macos' | 'linux'
  /** Client application version. */
  readonly version: string
}

/** Login rejected because refresh tokens cannot be persisted safely. */
export class GsAuthStorageError extends Error {
  constructor(options: { readonly cause?: unknown } = {}) {
    super('gsclaw-server login requires OS-backed secret storage for the refresh token',
      options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GsAuthStorageError'
  }
}

/** Why the server dropped the session; surfaced through `onSessionLost`. */
export type GsSessionLostReason = 'expired' | 'disabled'

/** Inputs for the authentication state machine. */
export interface GsAuthOptions {
  /** Effective endpoint resolver; read per request so overrides apply live. */
  readonly endpoint: () => string
  /** Absolute state directory holding the sealed refresh token. */
  readonly stateDir: string
  /** OS-backed secret storage for the refresh token. */
  readonly protector: GsRefreshTokenProtector
  /** Client identity embedded in login and refresh requests. */
  readonly client: GsClientIdentity
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: GsRequest
  /** ClientConfig pushed by login and refresh responses. */
  readonly onConfig?: (user: GsAuthUser, config: GsClientConfig) => void
  /** Fired when a session becomes live: login, token adoption, restore, refresh. */
  readonly onSessionEstablished?: (user: GsAuthUser) => void
  /** Fired when the server rejects the session; logout does not fire it. */
  readonly onSessionLost?: (reason: GsSessionLostReason) => void
}

/** Password login inputs accepted by {@link GsAuthService.loginWithPassword}. */
export interface GsPasswordLogin {
  readonly username: string
  readonly password: string
  readonly captchaId?: string
  readonly captchaCode?: string
}

/** Email-code login inputs accepted by {@link GsAuthService.loginWithEmailCode}. */
export interface GsEmailLogin {
  readonly account: string
  readonly code: string
}

/** UI-safe session snapshot; tokens are never exposed. */
export interface GsAuthSnapshot {
  readonly status: 'signed-out' | 'signed-in'
  readonly user?: GsAuthUser
}

/**
 * Return the sealed refresh-token path for one state directory.
 * @param stateDirectory - absolute directory holding gs-server state.
 * @returns the sealed token file path.
 */
export function gsRefreshTokenPath(stateDirectory: string): string {
  if (stateDirectory.length === 0 || /[\0\r\n]/u.test(stateDirectory) || !isAbsolute(stateDirectory)) {
    throw new GsAuthStorageError()
  }
  return join(resolve(stateDirectory), GS_REFRESH_TOKEN_FILENAME)
}

/**
 * Map one Node platform to the client identity the gateway expects.
 * @param platform - Node platform value.
 * @returns the gateway-facing platform name.
 */
export function gsClientPlatform(platform: NodeJS.Platform): GsClientIdentity['platform'] {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return 'linux'
}

/** Authentication state machine behind the Host-owned `gsServer` service. */
export class GsAuthService implements GsSessionTokenSource {
  private token: { readonly accessToken: string; readonly expiresAt: number | undefined } | undefined
  private refreshToken: string | undefined
  private currentUser: GsAuthUser | undefined
  private refreshInFlight: { generation: number; promise: Promise<GsTokenPair> } | undefined
  private restoreInFlight: { generation: number; promise: Promise<boolean> } | undefined
  private generation = 0
  private stateCommit: Promise<void> = Promise.resolve()
  private readonly statePath: string

  constructor(private readonly options: GsAuthOptions) {
    this.statePath = gsRefreshTokenPath(options.stateDir)
  }

  /**
   * Token-free session snapshot for UI projections.
   * @returns the snapshot; `signed-out` while no access token or user is held.
   */
  snapshot(): GsAuthSnapshot {
    if (this.token === undefined || this.currentUser === undefined) return { status: 'signed-out' }
    return { status: 'signed-in', user: this.currentUser }
  }

  /**
   * Current in-memory access token; implements {@link GsSessionTokenSource}.
   * @returns the token, or undefined while signed out.
   */
  accessToken(): string | undefined {
    return this.token?.accessToken
  }

  /**
   * Public server handshake; never requires a session.
   * @returns the server metadata.
   */
  getMeta(): Promise<GsServerMeta> {
    return gsJsonRequest<GsServerMeta>({
      endpoint: this.options.endpoint(),
      path: '/api/v1/meta',
      ...(this.options.request === undefined ? {} : { request: this.options.request }),
    })
  }

  /**
   * Enabled login methods; never requires a session.
   * @returns the login-method switches.
   */
  getAuthMethods(): Promise<GsAuthMethods> {
    return gsJsonRequest<GsAuthMethods>({
      endpoint: this.options.endpoint(),
      path: '/api/auth/methods',
      ...(this.options.request === undefined ? {} : { request: this.options.request }),
    })
  }

  /**
   * One-time graphical captcha; null when the server predates captchas.
   * @returns the captcha, or null on a legacy server.
   */
  async fetchCaptcha(): Promise<GsCaptcha | null> {
    try {
      return await gsJsonRequest<GsCaptcha>({
        endpoint: this.options.endpoint(),
        path: '/api/auth/captcha',
        ...(this.options.request === undefined ? {} : { request: this.options.request }),
      })
    } catch (cause) {
      if (cause instanceof GatewayError && cause.status === 404) return null
      throw cause
    }
  }

  /**
   * Password login; INVALID_CAPTCHA/INVALID_CREDENTIALS/429 arrive as GatewayError.
   * @param login - credentials plus the solved captcha when the server asked for one.
   * @returns the fresh token-free snapshot.
   */
  async loginWithPassword(login: GsPasswordLogin): Promise<GsAuthSnapshot> {
    const generation = ++this.generation
    const response = await gsJsonRequest<GsLoginResponse>({
      endpoint: this.options.endpoint(),
      method: 'POST',
      path: '/api/auth/login',
      body: {
        username: login.username,
        password: login.password,
        ...(login.captchaId === undefined ? {} : { captchaId: login.captchaId }),
        ...(login.captchaCode === undefined ? {} : { captchaCode: login.captchaCode }),
        client: this.options.client,
      },
      ...(this.options.request === undefined ? {} : { request: this.options.request }),
    })
    await this.completeLogin(response, generation)
    return this.snapshot()
  }

  /**
   * Send one email verification code to the account's registered address.
   * @param account - account name or email accepted by the gateway.
   * @returns the send-code outcome with second-normalized windows.
   */
  async sendEmailCode(account: string): Promise<GsEmailCodeResponse> {
    const response = await gsJsonRequest<GsEmailCodeResponse>({
      endpoint: this.options.endpoint(),
      method: 'POST',
      path: '/api/auth/email/send-code',
      body: { account },
      ...(this.options.request === undefined ? {} : { request: this.options.request }),
    })
    return {
      ...response,
      expiresIn: emailCodeWindowSeconds(response.expiresIn),
      resendIn: emailCodeWindowSeconds(response.resendIn),
    }
  }

  /**
   * Email-code login; the success shape matches password login.
   * @param login - account plus the received verification code.
   * @returns the fresh token-free snapshot.
   */
  async loginWithEmailCode(login: GsEmailLogin): Promise<GsAuthSnapshot> {
    const generation = ++this.generation
    const response = await gsJsonRequest<GsLoginResponse>({
      endpoint: this.options.endpoint(),
      method: 'POST',
      path: '/api/auth/email/verify',
      body: { account: login.account, code: login.code, client: this.options.client },
      ...(this.options.request === undefined ? {} : { request: this.options.request }),
    })
    await this.completeLogin(response, generation)
    return this.snapshot()
  }

  /**
   * Host token-write entry: adopt a token pair obtained outside the built-in
   * login flows (e.g. a host-rendered SSO or QR login). The refresh token is
   * sealed and persisted exactly like a password login, so adoption fails
   * when no OS-backed protector is available.
   * @param tokens - rotating token pair issued by the gateway.
   * @param user - authenticated user projection paired with the tokens.
   * @param config - ClientConfig delivered alongside the tokens.
   * @returns the fresh token-free snapshot.
   */
  async adoptTokens(tokens: GsTokenPair, user: GsAuthUser, config: GsClientConfig): Promise<GsAuthSnapshot> {
    await this.completeLogin({ token: tokens.accessToken, tokens, user, config }, ++this.generation)
    return this.snapshot()
  }

  /**
   * Restore the persisted session after a restart, single-flight.
   * Resolves false without a usable refresh token or when the server has
   * already revoked it; transport failures are rethrown so the persisted
   * token survives a server outage.
   * @returns true when a session is live after the call.
   */
  restoreSession(): Promise<boolean> {
    if (this.restoreInFlight?.generation === this.generation) return this.restoreInFlight.promise
    const generation = this.generation
    const promise = this.doRestore().finally(() => {
      if (this.restoreInFlight?.promise === promise) this.restoreInFlight = undefined
    })
    this.restoreInFlight = { generation, promise }
    return promise
  }

  /** Single-flight token rotation; implements {@link GsSessionTokenSource}. */
  async refreshAccessToken(): Promise<string> {
    return (await this.refreshTokens()).accessToken
  }

  /**
   * Single-flight refresh-token rotation. A 401/403 answer means the family
   * is gone: local credential state is wiped and `onSessionLost` fires.
   * @returns the rotated token pair.
   */
  refreshTokens(): Promise<GsTokenPair> {
    if (this.refreshInFlight?.generation === this.generation) return this.refreshInFlight.promise
    const generation = this.generation
    const promise = this.doRefresh().finally(() => {
      if (this.refreshInFlight?.promise === promise) this.refreshInFlight = undefined
    })
    this.refreshInFlight = { generation, promise }
    return promise
  }

  /** Revoke the family server-side on a best effort, then wipe local state. */
  async logout(): Promise<void> {
    const refreshToken = this.refreshToken
    const accessToken = this.token?.accessToken
    await this.dropLocalSession()
    if (refreshToken !== undefined) {
      try {
        await gsJsonRequest<undefined>({
          endpoint: this.options.endpoint(),
          method: 'POST',
          path: '/api/v1/auth/logout',
          body: { refreshToken },
          ...(accessToken === undefined ? {} : { accessToken }),
          ...(this.options.request === undefined ? {} : { request: this.options.request }),
        })
      } catch {
        // Logout is local-first: the server may already be unreachable.
      }
    }
  }

  private async completeLogin(response: GsLoginResponse, generation: number): Promise<void> {
    await this.serializeState(async () => {
      this.assertCurrent(generation)
      const tokens = response.tokens
      if (tokens !== undefined && tokens.refreshToken !== '') {
      // The refresh token is the only long-lived credential; without OS-backed
      // storage the login must fail rather than persist it in plaintext.
        if (!this.options.protector.available()) throw new GsAuthStorageError()
        await this.persistRefreshToken(tokens.refreshToken, generation)
        this.assertCurrent(generation)
        this.refreshToken = tokens.refreshToken
        this.token = {
          accessToken: tokens.accessToken,
          expiresAt: Date.now() + tokens.expiresIn * 1000,
        }
      } else {
        await this.removePersistedToken()
        this.assertCurrent(generation)
        // Legacy servers without rotating tokens: memory-only session that ends
        // with the process.
        this.refreshToken = undefined
        this.token = { accessToken: response.token, expiresAt: undefined }
      }
      this.currentUser = response.user
      this.options.onConfig?.(response.user, response.config)
      this.options.onSessionEstablished?.(response.user)
    })
  }

  private async doRestore(): Promise<boolean> {
    const generation = this.generation
    if (this.token !== undefined) return true
    if (!this.options.protector.available()) return false
    const persisted = await this.readPersistedRefreshToken()
    this.assertCurrent(generation)
    if (persisted === undefined) return false
    this.refreshToken = persisted
    try {
      await this.refreshTokens()
      return true
    } catch (cause) {
      if (cause instanceof GatewayError && (cause.status === 401 || cause.status === 403)) return false
      throw cause
    }
  }

  private async doRefresh(): Promise<GsTokenPair> {
    const generation = this.generation
    const presented = this.refreshToken ?? await this.readPersistedRefreshToken()
    this.assertCurrent(generation)
    if (presented === undefined) {
      throw new GatewayError('unauthorized', 401, 'no gsclaw-server session to refresh')
    }
    if (!this.options.protector.available()) {
      // Refreshing rotates the token; without sealing, the successor would be
      // lost or written in plaintext, so refuse before consuming the old one.
      throw new GsAuthStorageError()
    }
    try {
      const response = await gsJsonRequest<GsRefreshResponse>({
        endpoint: this.options.endpoint(),
        method: 'POST',
        path: '/api/v1/auth/refresh',
        body: { refreshToken: presented, client: this.options.client },
        ...(this.token === undefined ? {} : { accessToken: this.token.accessToken }),
        ...(this.options.request === undefined ? {} : { request: this.options.request }),
      })
      await this.completeLogin({ ...response, token: response.tokens.accessToken }, generation)
      return response.tokens
    } catch (cause) {
      if (generation === this.generation && cause instanceof GatewayError && (cause.status === 401 || cause.status === 403)) {
        await this.dropLocalSession()
        this.options.onSessionLost?.(cause.status === 403 ? 'disabled' : 'expired')
      }
      throw cause
    }
  }

  private async persistRefreshToken(refreshToken: string, generation: number): Promise<void> {
    const sealed = await this.options.protector.protect(refreshToken)
    this.assertCurrent(generation)
    await writeFileAtomic(this.statePath, `${Buffer.from(sealed).toString('base64')}\n`, {
      mode: PRIVATE_FILE_MODE,
      dirMode: PRIVATE_DIRECTORY_MODE,
    })
  }

  private async readPersistedRefreshToken(): Promise<string | undefined> {
    let stat: Awaited<ReturnType<typeof lstat>>
    try {
      stat = await lstat(this.statePath)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw cause
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GS_REFRESH_TOKEN_BYTES) return undefined

    const handle = await open(this.statePath, 'r')
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size > MAX_GS_REFRESH_TOKEN_BYTES) return undefined
      const buffer = Buffer.alloc(MAX_GS_REFRESH_TOKEN_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
      if (bytesRead > MAX_GS_REFRESH_TOKEN_BYTES) return undefined
      const sealed = Buffer.from(buffer.subarray(0, bytesRead).toString('utf8').trim(), 'base64')
      if (sealed.byteLength === 0) return undefined
      try {
        return await this.options.protector.unprotect(sealed)
      } catch {
        // Undecryptable state (different OS user, keychain reset) is a lost session.
        return undefined
      }
    } finally {
      await handle.close()
    }
  }

  private async dropLocalSession(): Promise<void> {
    this.generation += 1
    this.token = undefined
    this.refreshToken = undefined
    this.currentUser = undefined
    await this.serializeState(() => this.removePersistedToken())
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) throw new Error('gsclaw-server authentication operation was superseded')
  }

  private serializeState(operation: () => Promise<void>): Promise<void> {
    const next = this.stateCommit.then(operation)
    this.stateCommit = next.catch(() => { /* The caller receives the failure; later cleanup must still run. */ })
    return next
  }

  private async removePersistedToken(): Promise<void> {
    try {
      await unlink(this.statePath)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
}
