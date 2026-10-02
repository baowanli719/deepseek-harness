/**
 * ClientConfig cache for the gsclaw-server client layer.
 *
 * Login and refresh responses push the effective config; `getClientConfig()`
 * actively pulls `/api/client-config`. Downstream consumers (profile
 * composition, LLM routing, skill providers) subscribe to snapshots instead
 * of polling.
 *
 * @module
 */

import {
  authorizedJson,
  GatewayError,
  type GsRequest,
  type GsSessionTokenSource,
} from './client.ts'
import type {
  GsAuthUser,
  GsClientConfig,
  GsClientConfigResponse,
} from './contract.ts'

/** One effective user + configuration pair. */
export interface GsClientConfigSnapshot {
  readonly user: GsAuthUser
  readonly config: GsClientConfig
}

/** Subscriber notified whenever the cached snapshot changes. */
export type GsClientConfigListener = (snapshot: GsClientConfigSnapshot | undefined) => void

/** Inputs for the ClientConfig cache. */
export interface GsClientConfigCacheOptions {
  /** Effective endpoint resolver; read per request so overrides apply live. */
  readonly endpoint: () => string
  /** Session source backing the authorized pull. */
  readonly session: GsSessionTokenSource
  /** Optional fetch implementation for a host adapter or test. */
  readonly request?: GsRequest
}

/** Process-local ClientConfig cache with push updates and an active pull. */
export class GsClientConfigCache {
  private current: GsClientConfigSnapshot | undefined
  private generation = 0
  private readonly listeners = new Set<GsClientConfigListener>()

  constructor(private readonly options: GsClientConfigCacheOptions) {}

  /**
   * Latest snapshot, or undefined before the first login/refresh.
   * @returns the cached snapshot, or undefined.
   */
  snapshot(): GsClientConfigSnapshot | undefined {
    return this.current
  }

  /**
   * Accept one config pushed by a login or refresh response.
   * @param user - authenticated user the config belongs to.
   * @param config - the pushed effective ClientConfig.
   */
  update(user: GsAuthUser, config: GsClientConfig): void {
    this.generation += 1
    this.current = { user, config }
    this.notify()
  }

  /** Drop the cache when the session ends. */
  clear(): void {
    this.generation += 1
    if (this.current === undefined) return
    this.current = undefined
    this.notify()
  }

  /**
   * Subscribe to snapshot changes; returns the unsubscribe function.
   * @param listener - notified with the new snapshot, or undefined on clear.
   * @returns the unsubscribe function.
   */
  subscribe(listener: GsClientConfigListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Actively pull `/api/client-config` and cache the answer.
   * @returns the fresh snapshot.
   */
  async getClientConfig(): Promise<GsClientConfigSnapshot> {
    const generation = this.generation
    const response = await authorizedJson<GsClientConfigResponse>({
      endpoint: this.options.endpoint(),
      path: '/api/client-config',
      session: this.options.session,
      ...(this.options.request === undefined ? {} : { request: this.options.request }),
    })
    if (generation !== this.generation) {
      throw new GatewayError('unauthorized', 401, 'gsclaw-server config request was superseded by a session change')
    }
    this.current = { user: response.user, config: response.config }
    this.notify()
    return this.current
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.current)
  }
}
