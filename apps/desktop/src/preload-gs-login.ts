/** Minimal sandbox bridge for the gs-worker password and email-code login form. */

import { contextBridge, ipcRenderer } from 'electron'
import { GS_LOGIN_IPC, type GsLoginApi } from './gs-login-api.ts'

const locale = process.argv.find(value => value.startsWith('--dsh-gs-login-locale='))?.split('=')[1]
const clientVersion = process.argv.find(value => value.startsWith('--dsh-gs-login-version='))?.split('=')[1]
if ((locale !== 'zh' && locale !== 'en') || clientVersion === undefined) throw new Error('gs login: missing window settings')

const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const result = await ipcRenderer.invoke(channel, ...args) as {
    ok: boolean
    value?: T
    error?: string
    status?: number
    retryAfter?: number
  }
  if (result.ok) return result.value as T
  throw Object.assign(new Error(result.error ?? 'Login failed'), { status: result.status, retryAfter: result.retryAfter })
}

const api: GsLoginApi = {
  locale,
  clientVersion,
  meta: () => invoke(GS_LOGIN_IPC.meta),
  captcha: () => invoke(GS_LOGIN_IPC.captcha),
  password: data => invoke(GS_LOGIN_IPC.password, data),
  emailCode: account => invoke(GS_LOGIN_IPC.emailCode, account),
  emailLogin: (account, code) => invoke(GS_LOGIN_IPC.emailLogin, account, code),
}
contextBridge.exposeInMainWorld('dshGsLogin', api)
