/** Default mapping and visibility rules. */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SCENARIOS, resolveScenarioShortcuts } from '../src/client/scenarios.ts'
import { zh } from '../src/client/locale.ts'

const CUSTOM = {
  enabled: true,
  items: [{ id: 'custom', label: '自定义场景', skill: 'custom-skill' }],
}

function translate(key: keyof typeof zh): string {
  return zh[key]
}

describe('scenario resolution', () => {
  it('maps the four defaults to their documented skills and locale labels', () => {
    expect(DEFAULT_SCENARIOS.map(item => ({ id: item.id, skill: item.skill }))).toEqual([
      { id: 'zhidu-knowledge', skill: 'zhidu-knowledge' },
      { id: 'gs-research-summary', skill: 'gs-research-summary' },
      { id: 'juyuan-data', skill: 'juyuan-data' },
      { id: 'miaoxiang-data', skill: 'miaoxiang-data' },
    ])
    expect(resolveScenarioShortcuts(undefined, translate)).toEqual([
      { id: 'zhidu-knowledge', label: zh.defaultZhidu, skill: 'zhidu-knowledge' },
      { id: 'gs-research-summary', label: zh.defaultResearch, skill: 'gs-research-summary' },
      { id: 'juyuan-data', label: zh.defaultJuyuan, skill: 'juyuan-data' },
      { id: 'miaoxiang-data', label: zh.defaultEastMoney, skill: 'miaoxiang-data' },
    ])
  })

  it('hides null, global-off, and item-off configurations', () => {
    expect(resolveScenarioShortcuts(null, translate)).toEqual([])
    expect(resolveScenarioShortcuts({ enabled: false, items: CUSTOM.items }, translate)).toEqual([])
    expect(resolveScenarioShortcuts({
      enabled: true,
      items: [
        { id: 'off', label: '隐藏', skill: 'off', enabled: false },
        { id: 'on', label: '显示', skill: 'on', enabled: true },
      ],
    }, translate)).toEqual([{ id: 'on', label: '显示', skill: 'on', enabled: true }])
  })

  it('keeps custom ids, labels, skills, and server order', () => {
    expect(resolveScenarioShortcuts(CUSTOM, translate)).toEqual(CUSTOM.items)
  })
})
