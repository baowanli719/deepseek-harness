/** Token-free contract between the gs-worker login renderer and the Desktop main process. */

export const GS_LOGIN_IPC = {
  meta: 'dsh-gs-login:meta',
  captcha: 'dsh-gs-login:captcha',
  password: 'dsh-gs-login:password',
  emailCode: 'dsh-gs-login:email-code',
  emailLogin: 'dsh-gs-login:email-login',
} as const

export interface GsLoginMeta {
  readonly endpoint: string
  readonly meta: {
    readonly serviceName: string
    readonly loginMethods: readonly ('password' | 'email_code')[]
    readonly minimumClientVersion: string
    readonly brand?: { readonly name?: string } | null
  }
}

export interface GsLoginCaptcha {
  readonly captchaId: string
  readonly svg: string
  readonly expiresIn: number
}

export interface GsEmailCodeResult {
  readonly maskedEmail: string
  readonly resendIn: number
}

export interface GsLoginSession {
  readonly status: 'signed-out' | 'signed-in'
}

export interface GsLoginApi {
  readonly locale: 'zh' | 'en'
  readonly clientVersion: string
  meta(): Promise<GsLoginMeta>
  captcha(): Promise<GsLoginCaptcha | null>
  password(data: { username: string; password: string; captchaId?: string; captchaCode?: string }): Promise<GsLoginSession>
  emailCode(account: string): Promise<GsEmailCodeResult>
  emailLogin(account: string, code: string): Promise<GsLoginSession>
}
