/** Isolated native password and email-code login window for the gs-desktop profile. */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { GS_LOGIN_IPC } from './gs-login-api.ts'
import { GsLoginRequestError, type GsLoginBackend } from './gs-login-backend.ts'
import type { DesktopLocale } from './locale.ts'

export async function openGsLoginWindow(
  locale: DesktopLocale,
  clientVersion: string,
  backend: GsLoginBackend,
  onSuccess: () => Promise<void>,
): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 440,
    height: 700,
    minWidth: 380,
    minHeight: 620,
    useContentSize: true,
    center: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    // Windows may refuse to reveal the first hidden HWND after loadFile.
    show: process.platform === 'win32',
    autoHideMenuBar: true,
    title: locale.id === 'zh-CN' ? '登录国盛办公AI' : 'Sign in to gs-worker',
    backgroundColor: '#202124',
    ...(process.platform === 'win32' ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#00000000', symbolColor: '#7f858f', height: 36 },
      hasShadow: true,
      roundedCorners: true,
      thickFrame: true,
    } : process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 10 },
    } : {}),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload-gs-login.cjs', import.meta.url)),
      additionalArguments: [
        `--dsh-gs-login-locale=${locale.id === 'zh-CN' ? 'zh' : 'en'}`,
        `--dsh-gs-login-version=${clientVersion}`,
      ],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => { event.preventDefault() })
  const assertSender = (event: IpcMainInvokeEvent): void => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('gs login: rejected action from an unowned frame')
    }
  }
  const handle = (channel: string, action: (...args: unknown[]) => Promise<unknown>): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      assertSender(event)
      try { return { ok: true, value: await action(...args) } }
      catch (cause) {
        if (cause instanceof GsLoginRequestError) {
          return { ok: false, error: cause.message, status: cause.status, retryAfter: cause.retryAfter }
        }
        return { ok: false, error: '无法连接服务端', status: 0 }
      }
    })
  }
  handle(GS_LOGIN_IPC.meta, () => backend.meta())
  handle(GS_LOGIN_IPC.captcha, () => backend.captcha())
  handle(GS_LOGIN_IPC.password, async (data) => {
    if (!isRecord(data) || typeof data.username !== 'string' || typeof data.password !== 'string'
      || (data.captchaId !== undefined && typeof data.captchaId !== 'string')
      || (data.captchaCode !== undefined && typeof data.captchaCode !== 'string')) throw new Error('invalid login input')
    const session = await backend.password({ username: data.username, password: data.password,
      ...(typeof data.captchaId === 'string' ? { captchaId: data.captchaId } : {}),
      ...(typeof data.captchaCode === 'string' ? { captchaCode: data.captchaCode } : {}) })
    if (session.status === 'signed-in') await onSuccess()
    return session
  })
  handle(GS_LOGIN_IPC.emailCode, (account) => {
    if (typeof account !== 'string') throw new Error('invalid account')
    return backend.emailCode(account)
  })
  handle(GS_LOGIN_IPC.emailLogin, async (account, code) => {
    if (typeof account !== 'string' || typeof code !== 'string') throw new Error('invalid login input')
    const session = await backend.emailLogin(account, code)
    if (session.status === 'signed-in') await onSuccess()
    return session
  })
  window.once('closed', () => {
    for (const channel of Object.values(GS_LOGIN_IPC)) ipcMain.removeHandler(channel)
  })
  try {
    await window.loadFile(join(app.getAppPath(), 'renderer', 'gs-login.html'))
    if (!window.isDestroyed()) window.show()
  } catch (cause) {
    if (!window.isDestroyed()) window.destroy()
    throw cause
  }
  return window
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
