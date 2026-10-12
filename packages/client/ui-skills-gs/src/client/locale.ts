/** Product copy for the gs-worker Skills settings page. */
export const NS = 'gs.skills'
/** 中文文案字典。 */
export const zh = {
  title: '技能管理', intro: '查看可用技能，并管理本地技能。', loading: '正在读取技能…',
  empty: '暂无可用技能', signedOut: '登录后可查看技能', failed: '技能列表暂时不可用',
  server: '服务端', local: '本地', other: '其他', userOnly: '仅用户调用', unavailable: '当前不可调用',
  trustedOnly: '仅限受信任模型',
  trustedSessionRequired: '该技能仅限受信任模型会话内调用',
  runtimeUnsupported: '该技能的执行方式暂不支持', disabled: '已关闭，启用后可调用',
  createTitle: '新建本地技能', name: '技能名称', description: '用途说明', create: '创建技能',
  creating: '正在创建…', createFailed: '创建失败，请检查名称是否已存在或服务端权限。',
  createAllowed: '当前账号有权限新建本地 Skill。',
  createForbidden: '管理员已禁止本地创建 Skill，可使用服务端下发的 Skill；如有需要请联系管理员开通。',
  createSignIn: '登录后可确认本地 Skill 新建权限。',
  createPermissionUnavailable: '暂时无法确认新建权限，请刷新后重试。',
  managedRoot: '本地技能目录', refresh: '刷新', enabled: '启用', toggleFailed: '保存技能设置失败，请重试。',
} as const
/** English dictionary mirroring {@link zh} key for key. */
export const en: Record<keyof typeof zh, string> = {
  title: 'Skills', intro: 'View available skills and manage local skills.', loading: 'Loading skills…',
  empty: 'No skills available', signedOut: 'Sign in to view skills', failed: 'Skills are temporarily unavailable',
  server: 'Server', local: 'Local', other: 'Other', userOnly: 'User only', unavailable: 'Unavailable',
  trustedOnly: 'Trusted models only',
  trustedSessionRequired: 'This skill can only be invoked inside a trusted model session',
  runtimeUnsupported: 'This skill execution method is not supported', disabled: 'Turn on this skill to use it',
  createTitle: 'Create local skill', name: 'Skill name', description: 'Description', create: 'Create skill',
  creating: 'Creating…', createFailed: 'Creation failed. Check the name and server permission.',
  createAllowed: 'Your account can create local skills.',
  createForbidden: 'Your administrator has disabled local skill creation. Server-delivered skills remain available; contact your administrator to request access.',
  createSignIn: 'Sign in to check permission to create local skills.',
  createPermissionUnavailable: 'Creation permission is temporarily unavailable. Refresh to try again.',
  managedRoot: 'Local skills folder', refresh: 'Refresh', enabled: 'Enabled', toggleFailed: 'Could not save the skill setting. Try again.',
}
type Key = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'gs.skills': Key }
}
