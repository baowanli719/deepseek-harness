/** Localized reader chrome, shared across authentication-specific providers. */
export const NS = 'linkPreview'
/** Chinese reader messages. */
export const zh = {
  title: '来源原文', reload: '重新加载', loading: '正在读取原文',
  raw: '查看原始文本', formatted: '查看排版',
  quote: '引用选中原文', quoted: '已引用到输入框', quoteFailed: '暂时无法引用，请稍后重试',
  copy: '复制', copied: '已复制', code: '代码', wrap: '自动换行', unwrap: '取消换行', footnotes: '脚注',
  truncated: '当前内容未完整显示',
  unauthorized: '登录已过期，请重新登录后重试',
  forbidden: '你没有权限查看此内容',
  'source-mismatch': '原文链接与当前登录的服务地址不一致，请联系管理员更新制度库链接',
  'not-found': '来源不存在或已不可用',
  unavailable: '此来源的预览插件不可用',
  failed: '读取失败，请重试',
}
/** English messages with the same localized keys. */
export const en: Record<keyof typeof zh, string> = {
  title: 'Source text', reload: 'Reload', loading: 'Reading source',
  raw: 'View raw text', formatted: 'View formatted text',
  quote: 'Quote selection', quoted: 'Quote added to the message draft', quoteFailed: 'Could not insert the quote. Retry shortly.',
  copy: 'Copy', copied: 'Copied', code: 'Code', wrap: 'Wrap lines', unwrap: 'Unwrap lines', footnotes: 'Footnotes',
  truncated: 'The displayed content is incomplete',
  unauthorized: 'Your sign-in expired. Sign in again and retry.',
  forbidden: 'You do not have permission to view this content.',
  'source-mismatch': 'The source link does not match your signed-in service. Ask an administrator to update the policy links.',
  'not-found': 'The source does not exist or is no longer available.',
  unavailable: 'The preview plugin for this source is unavailable.',
  failed: 'Could not read the source. Retry.',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shared text source reader copy. */
    linkPreview: keyof typeof zh
  }
}
