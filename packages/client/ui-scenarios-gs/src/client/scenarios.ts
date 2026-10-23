/** Default scenarios and visibility resolution. */
import type { GsScenarioShortcutsSetting } from './contract.ts'
import type { DefaultScenarioLabelKey } from './locale.ts'

/** One client-owned default scenario before locale resolution. */
export interface DefaultScenario {
  readonly id: string
  readonly labelKey: DefaultScenarioLabelKey
  readonly skill: string
}

/** The four GS defaults, in display order. */
export const DEFAULT_SCENARIOS: readonly DefaultScenario[] = [
  { id: 'zhidu-knowledge', labelKey: 'defaultZhidu', skill: 'zhidu-knowledge' },
  { id: 'gs-research-summary', labelKey: 'defaultResearch', skill: 'gs-research-summary' },
  { id: 'juyuan-data', labelKey: 'defaultJuyuan', skill: 'juyuan-data' },
  { id: 'miaoxiang-data', labelKey: 'defaultEastMoney', skill: 'miaoxiang-data' },
]

/** One display-ready scenario button. */
export interface ScenarioShortcutView {
  readonly id: string
  readonly label: string
  readonly skill: string
}

/**
 * Resolve the visible list from the three-state server setting.
 * @param setting - undefined for defaults, null for hidden, or a server list.
 * @param translate - locale lookup used only for client-owned default labels.
 * @returns enabled items in server order, or the localized defaults.
 */
export function resolveScenarioShortcuts(
  setting: GsScenarioShortcutsSetting,
  translate: (key: DefaultScenarioLabelKey) => string,
): readonly ScenarioShortcutView[] {
  if (setting === undefined) {
    return DEFAULT_SCENARIOS.map(({ labelKey, ...item }) => ({ ...item, label: translate(labelKey) }))
  }
  if (setting === null || !setting.enabled) return []
  return setting.items.filter(item => item.enabled !== false)
}
