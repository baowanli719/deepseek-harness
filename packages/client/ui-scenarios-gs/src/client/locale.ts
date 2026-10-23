/** Product copy for the GS scenario shortcuts. */
export const NS = 'gs.scenarios'

/** 中文文案字典。 */
export const zh = {
  groupAria: '场景快捷入口',
  defaultZhidu: '制度库查询',
  defaultResearch: '研报分析',
  defaultJuyuan: '聚源金融数据',
  defaultEastMoney: '东财妙想数据',
} as const

/** English dictionary mirroring {@link zh} key for key. */
export const en: Record<keyof typeof zh, string> = {
  groupAria: 'Scenario shortcuts',
  defaultZhidu: 'Policy library query',
  defaultResearch: 'Research report analysis',
  defaultJuyuan: 'Juyuan financial data',
  defaultEastMoney: 'East Money Miaoxiang financial data',
}

/** Locale keys accepted by the slot namespace. */
export type Key = keyof typeof zh

/** Locale keys used by the client-owned default scenarios. */
export type DefaultScenarioLabelKey = Exclude<Key, 'groupAria'>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'gs.scenarios': Key }
}
