/** Product copy for the gs-server notice banner. */
export const NS = 'gs.notice'

/** 中文文案字典。 */
export const zh = {
  bannerAria: '服务端通知',
  close: '关闭',
  closeAria: '关闭通知',
} as const

/** English dictionary mirroring {@link zh} key for key. */
export const en: Record<keyof typeof zh, string> = {
  bannerAria: 'Server notice',
  close: 'Close',
  closeAria: 'Dismiss notice',
}

/** Locale keys accepted by the slot namespace. */
export type Key = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'gs.notice': Key }
}
