/** Product copy for the gs-worker untrusted-model risk disclosure. */
export const NS = 'gs.modelRisk'

/** 中文文案字典。 */
export const zh = {
  lockAria: '云端模型风险揭示书',
  lockTitleUnsigned: '非可信云端模型：签署风险揭示书后使用',
  lockTitleSigned: '已签署风险揭示书，查看或下载',
  lockTitleUnavailable: '风险状态暂不可用，点击重试',
  retry: '重新读取协议',
  loadingTitle: '加载风险揭示书',
  loading: '正在读取协议…',
  loadFailed: '协议加载失败',
  modelLabel: '模型：',
  signFailed: '签署失败，请重新打开协议后重试',
  downloadFailed: 'PDF 下载失败',
  revisionChanged: '协议已更新，请重新阅读并签署',
  signedReady: '已签署，可使用此模型。',
  mailSent: '协议已发送至用户和管理员邮箱。',
  mailFailed: '邮件发送失败，已保存协议，请联系管理员补发。',
  mailPending: '协议已保存，邮件等待发送。',
  downloadPdf: '下载签署协议 PDF',
  fullName: '签署人姓名',
  email: '接收协议的邮箱',
  acknowledge: '我已阅读并理解全文，自愿承担使用该非可信云端模型的数据安全风险。',
  signaturePrompt: '请在下方手写签名：',
  signatureAria: '手写签名区域',
  clearSignature: '清除签名',
  sign: '签署并放行',
  working: '处理中…',
  close: '关闭',
} as const

/** English dictionary mirroring {@link zh} key for key. */
export const en: Record<keyof typeof zh, string> = {
  lockAria: 'Cloud model risk disclosure',
  lockTitleUnsigned: 'Untrusted cloud model: sign the risk disclosure before use',
  lockTitleSigned: 'Risk disclosure signed; view or download',
  lockTitleUnavailable: 'Risk status unavailable; click to retry',
  retry: 'Reload disclosure',
  loadingTitle: 'Loading risk disclosure',
  loading: 'Loading the disclosure…',
  loadFailed: 'Could not load the disclosure',
  modelLabel: 'Model: ',
  signFailed: 'Signing failed. Reopen the disclosure and try again.',
  downloadFailed: 'PDF download failed',
  revisionChanged: 'The disclosure was updated. Read it again and re-sign.',
  signedReady: 'Signed. You can use this model.',
  mailSent: 'The disclosure was emailed to you and the administrators.',
  mailFailed: 'Email delivery failed. The signed disclosure is saved; ask an administrator to resend it.',
  mailPending: 'The disclosure is saved; email delivery is pending.',
  downloadPdf: 'Download signed disclosure PDF',
  fullName: 'Signer name',
  email: 'Email to receive the disclosure',
  acknowledge: 'I have read and understood the full text, and I voluntarily accept the data-security risks of using this untrusted cloud model.',
  signaturePrompt: 'Sign by hand below:',
  signatureAria: 'Handwritten signature area',
  clearSignature: 'Clear signature',
  sign: 'Sign and continue',
  working: 'Working…',
  close: 'Close',
}

/** Locale keys accepted by the slot namespace. */
export type Key = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'gs.modelRisk': Key }
}
