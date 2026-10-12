/** Typed account locale dictionaries. */
export const zh = {
  signedOut: '未登录', loading: '正在加载', administrator: '管理员',
  open: '账户菜单', settings: '设置', skills: '技能管理', about: '关于', logout: '退出登录',
  logoutFailed: '退出登录失败，请重试',
  product: '国盛办公AI', tagline: '让日常办公更高效',
  description: '面向办公场景的智能助手，支持文档处理、数据分析与工作任务协作。',
  version: '当前版本', versionUnavailable: '暂无版本信息',
  capabilities: '办公能力', capabilitiesDetail: '通过技能扩展工作能力，在对话中完成日常任务。',
  accountService: '企业服务', accountServiceDetail: '账户、模型与可用技能由企业服务统一管理。',
} as const
/** English account locale dictionary with every Chinese key. */
export const en: Record<keyof typeof zh, string> = {
  signedOut: 'Signed out', loading: 'Loading', administrator: 'Administrator',
  open: 'Account menu', settings: 'Settings', skills: 'Skills', about: 'About', logout: 'Sign out',
  logoutFailed: 'Sign out failed. Try again.',
  product: 'Guosheng Office AI', tagline: 'Make everyday work more efficient',
  description: 'An office assistant for document processing, data analysis, and collaborative tasks.',
  version: 'Current version', versionUnavailable: 'Version unavailable',
  capabilities: 'Office capabilities', capabilitiesDetail: 'Extend your workflow with skills and complete everyday tasks in conversation.',
  accountService: 'Enterprise services', accountServiceDetail: 'Accounts, models, and available skills are managed by your enterprise service.',
}
/** Account locale keys accepted by the slot namespace. */
export type Key = keyof typeof zh
