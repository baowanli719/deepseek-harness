/** Host-owned loopback client for the gs-worker login window. */

import type { GsEmailCodeResult, GsLoginCaptcha, GsLoginMeta, GsLoginSession } from './gs-login-api.ts'

export class GsLoginRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter?: number) { super(message) }
}

export interface GsLoginBackend {
  /** Pull a token-free update notice through the Host-owned server session. */
  appUpdate(signal?: AbortSignal): Promise<unknown>
  session(): Promise<GsLoginSession>
  meta(): Promise<GsLoginMeta>
  captcha(): Promise<GsLoginCaptcha | null>
  password(data: { username: string; password: string; captchaId?: string; captchaCode?: string }): Promise<GsLoginSession>
  emailCode(account: string): Promise<GsEmailCodeResult>
  emailLogin(account: string, code: string): Promise<GsLoginSession>
}

export function connectGsLogin(authenticatedUrl: string, send: (input: string, init?: RequestInit) => Promise<Response>): GsLoginBackend {
  const origin = new URL(authenticatedUrl).origin
  const request = async <T>(path: string, body?: object, signal?: AbortSignal): Promise<T> => {
    const response = await send(new URL(path, origin).href, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      redirect: 'error',
      ...(signal === undefined ? {} : { signal }),
      headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const value: unknown = await response.json()
    if (!response.ok) {
      const failure = typeof value === 'object' && value !== null
        ? value as { error?: unknown; retryAfter?: unknown } : {}
      throw new GsLoginRequestError(
        typeof failure.error === 'string' ? failure.error : 'gs-server request failed',
        response.status,
        typeof failure.retryAfter === 'number' ? failure.retryAfter : undefined,
      )
    }
    return value as T
  }
  return {
    appUpdate: signal => request('/api/gs-server/app-update', undefined, signal),
    session: () => request('/api/gs-server/session'),
    meta: () => request('/api/gs-server/meta'),
    captcha: async () => (await request<{ captcha: GsLoginCaptcha | null }>('/api/gs-server/captcha')).captcha,
    password: data => request('/api/gs-server/login', data),
    emailCode: account => request('/api/gs-server/email-code', { account }),
    emailLogin: (account, code) => request('/api/gs-server/email-login', { account, code }),
  }
}
