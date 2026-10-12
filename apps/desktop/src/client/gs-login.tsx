/** Password and email-code login surface ported from dsh-desktop's native login window. */

import { useEffect, useState, type FormEvent, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import type { GsLoginApi, GsLoginCaptcha, GsLoginMeta } from '../gs-login-api.ts'
import { DESKTOP_BRAND_LOGO_DATA_URI } from './gs-brand-logo.ts'
import './gs-login.css'

declare global { interface Window { dshGsLogin: GsLoginApi } }

type Method = 'password' | 'email_code'
const api = window.dshGsLogin
const zh = api.locale === 'zh'
const copy = zh ? {
  subheading: '使用邮箱验证码或账号密码登录', passwordTab: '账号密码', emailCodeTab: '邮箱验证码',
  accountLabel: '账号', accountPlaceholder: '请输入账号', passwordLabel: '登录密码',
  passwordPlaceholder: '请输入密码', emailCodeLabel: '邮箱验证码', emailCodePlaceholder: '6 位验证码',
  sendCode: '获取验证码', sendingCode: '发送中', captchaLabel: '图形验证码',
  captchaPlaceholder: '请输入图中算式结果', captchaAlt: '图形验证码，点击刷新',
  submit: '安全登录', submitting: '正在登录…', offline: '无法连接服务端，请检查网络或稍后重试',
  connecting: '正在连接服务端…', loginFailed: '登录失败', footer: '企业内部系统 · 请勿处理非工作信息',
} : {
  subheading: 'Sign in with an email code or account password', passwordTab: 'Account password', emailCodeTab: 'Email code',
  accountLabel: 'Account', accountPlaceholder: 'Enter your account', passwordLabel: 'Password',
  passwordPlaceholder: 'Enter your password', emailCodeLabel: 'Email code', emailCodePlaceholder: '6-digit code',
  sendCode: 'Send code', sendingCode: 'Sending', captchaLabel: 'Captcha',
  captchaPlaceholder: 'Enter the result shown', captchaAlt: 'Captcha image, click to refresh',
  submit: 'Sign in', submitting: 'Signing in…', offline: 'Cannot reach the server. Check your network and try again.',
  connecting: 'Connecting to the server…', loginFailed: 'Sign-in failed', footer: 'Internal system · do not process non-work information',
}

function Icon({ kind }: { kind: 'user' | 'key' | 'mail' | 'shield' | 'alert' | 'arrow' }): JSX.Element {
  const paths = {
    user: <><circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" /></>,
    key: <><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" /></>,
    mail: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" /></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></>,
    alert: <><path d="m10.3 3.9-8.5 14.2A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
  }
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{paths[kind]}</svg>
}

function belowMinimum(current: string, minimum: string): boolean {
  const left = current.split(/[.-]/u).map(value => Number.parseInt(value, 10) || 0)
  const right = minimum.split(/[.-]/u).map(value => Number.parseInt(value, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) < (right[index] ?? 0)
  }
  return false
}

function Login(): JSX.Element {
  const [meta, setMeta] = useState<GsLoginMeta>()
  const [offline, setOffline] = useState(false)
  const [method, setMethod] = useState<Method>('email_code')
  const [account, setAccount] = useState('')
  const [credential, setCredential] = useState('')
  const [maskedEmail, setMaskedEmail] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [captcha, setCaptcha] = useState<GsLoginCaptcha | null>(null)
  const [captchaInput, setCaptchaInput] = useState('')
  const [captchaSupported, setCaptchaSupported] = useState(true)
  const [lockRemaining, setLockRemaining] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void api.meta().then((result) => {
      if (cancelled) return
      setMeta(result)
      setOffline(false)
      setMethod(result.meta.loginMethods.includes('email_code') ? 'email_code' : 'password')
    }).catch(() => { if (!cancelled) setOffline(true) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (countdown <= 0 && lockRemaining <= 0) return
    const timer = window.setInterval(() => {
      setCountdown(value => Math.max(value - 1, 0))
      setLockRemaining(value => Math.max(value - 1, 0))
    }, 1000)
    return () => { window.clearInterval(timer) }
  }, [countdown > 0, lockRemaining > 0])

  const failure = (cause: unknown): void => {
    const value = cause as { status?: number; retryAfter?: number; message?: string }
    if (value.status === 0) { setOffline(true); return }
    if (value.status === 429) { setLockRemaining(Math.ceil(value.retryAfter || 900)); return }
    setError(value.message ?? copy.loginFailed)
  }
  const refreshCaptcha = async (): Promise<void> => {
    setCaptchaInput('')
    try {
      const next = await api.captcha()
      setCaptcha(next)
      if (next === null) setCaptchaSupported(false)
    } catch { setCaptcha(null) }
  }
  useEffect(() => {
    if (method === 'password' && meta !== undefined && captchaSupported && captcha === null) void refreshCaptcha()
  }, [method, meta, captchaSupported])
  const switchMethod = (next: Method): void => {
    setMethod(next); setCredential(''); setCaptcha(null); setCaptchaInput(''); setError('')
  }
  const sendCode = async (): Promise<void> => {
    setSending(true); setError('')
    try {
      const result = await api.emailCode(account.trim())
      setMaskedEmail(result.maskedEmail); setCountdown(result.resendIn)
    } catch (cause) { failure(cause) }
    finally { setSending(false) }
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setSubmitting(true); setError('')
    try {
      if (method === 'password') {
        await api.password({ username: account.trim(), password: credential,
          ...(captcha === null ? {} : { captchaId: captcha.captchaId, captchaCode: captchaInput.trim() }) })
      } else await api.emailLogin(account.trim(), credential.trim())
    } catch (cause) { failure(cause) }
    finally { setSubmitting(false) }
  }
  const methods = meta?.meta.loginMethods ?? []
  const tooOld = meta !== undefined && belowMinimum(api.clientVersion, meta.meta.minimumClientVersion)
  const heading = meta?.meta.brand?.name?.trim() || '国盛办公AI'
  const blocked = submitting || offline || tooOld || meta === undefined || lockRemaining > 0
    || account.trim() === '' || credential.trim() === ''
    || (method === 'password' && captchaSupported && captchaInput.trim() === '')
  const alert = tooOld
    ? (zh ? `客户端版本过低，请升级至 ${meta.meta.minimumClientVersion} 及以上` : `Please upgrade to ${meta.meta.minimumClientVersion} or later.`)
    : offline ? copy.offline
      : lockRemaining > 0 ? (zh ? `失败次数过多，账号已锁定，请 ${Math.floor(lockRemaining / 60)} 分 ${lockRemaining % 60} 秒后重试` : `Too many failures. Try again in ${Math.floor(lockRemaining / 60)}m ${lockRemaining % 60}s.`)
        : error

  return <main className="gs-login-surface"><header className="gs-login-frame" aria-hidden="true" />
    <section className="gs-login-center"><div role="dialog" aria-labelledby="gs-login-title" className="gs-login-card">
      <div className="gs-login-heading"><img src={DESKTOP_BRAND_LOGO_DATA_URI} alt="" />
        <div><h2 id="gs-login-title">{heading}</h2><p>{copy.subheading}</p></div></div>
      {methods.length > 1 && <div role="tablist" aria-label={heading} className="gs-login-tabs">
        {methods.includes('password') && <button type="button" role="tab" aria-selected={method === 'password'} onClick={() => { switchMethod('password') }}>{copy.passwordTab}</button>}
        {methods.includes('email_code') && <button type="button" role="tab" aria-selected={method === 'email_code'} onClick={() => { switchMethod('email_code') }}>{copy.emailCodeTab}</button>}
      </div>}
      <form onSubmit={(event) => { void submit(event) }}>
        <label htmlFor="gs-login-account">{copy.accountLabel}</label>
        <div className="gs-login-field"><Icon kind="user" /><input id="gs-login-account" value={account} autoComplete="username" placeholder={copy.accountPlaceholder} onChange={(event) => { setAccount(event.target.value) }} /></div>
        <label htmlFor="gs-login-credential">{method === 'password' ? copy.passwordLabel : copy.emailCodeLabel}</label>
        <div className="gs-login-field">{method === 'password' ? <Icon kind="key" /> : <Icon kind="mail" />}
          <input id="gs-login-credential" type={method === 'password' ? 'password' : 'text'} inputMode={method === 'email_code' ? 'numeric' : undefined} value={credential} autoComplete={method === 'password' ? 'current-password' : 'one-time-code'} placeholder={method === 'password' ? copy.passwordPlaceholder : copy.emailCodePlaceholder} onChange={(event) => { setCredential(event.target.value) }} />
          {method === 'email_code' && <button type="button" className="gs-login-inline" disabled={sending || countdown > 0 || !account.trim()} onClick={() => { void sendCode() }}>{sending ? copy.sendingCode : countdown > 0 ? `${countdown}s` : copy.sendCode}</button>}
        </div>
        {method === 'password' && captchaSupported && <><label htmlFor="gs-login-captcha">{copy.captchaLabel}</label>
          <div className="gs-login-field"><Icon kind="shield" /><input id="gs-login-captcha" value={captchaInput} inputMode="numeric" autoComplete="off" placeholder={copy.captchaPlaceholder} onChange={(event) => { setCaptchaInput(event.target.value) }} />
            {captcha !== null && <img className="gs-login-captcha" src={`data:image/svg+xml;utf8,${encodeURIComponent(captcha.svg)}`} alt={copy.captchaAlt} title={copy.captchaAlt} onClick={() => { void refreshCaptcha() }} />}</div></>}
        {maskedEmail && <p className="gs-login-hint">{zh ? `验证码已发送至 ${maskedEmail}` : `Code sent to ${maskedEmail}`}</p>}
        {alert && <div role="alert" className="gs-login-error"><Icon kind="alert" />{alert}</div>}
        <button className="gs-login-submit" type="submit" disabled={blocked}>{submitting ? copy.submitting : copy.submit}{!submitting && <Icon kind="arrow" />}</button>
      </form>
      <div className="gs-login-status"><span className={offline ? 'offline' : ''} />{meta ? (zh ? `已连接 ${meta.meta.serviceName} · v${api.clientVersion}` : `Connected to ${meta.meta.serviceName} · v${api.clientVersion}`) : offline ? copy.offline : copy.connecting}</div>
    </div></section><footer>{copy.footer}</footer>
  </main>
}

const root = document.getElementById('root')
if (root === null) throw new Error('gs login: missing root')
createRoot(root).render(<Login />)
