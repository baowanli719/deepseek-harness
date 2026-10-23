/** Server-configured scenario actions beneath the composer card. */
import { useMemo, type ReactNode } from 'react'
import {
  Button, IconDatabaseOutlineMedium, IconListPenOutlineMedium, IconSearchOutlineMedium,
  IconSkillOutlineMedium, IconSparkleMedium,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { scenarioSkillInsertion } from './insertion.ts'
import { SCENARIO_SHORTCUTS_ADDRESS } from './resource.ts'
import { resolveScenarioShortcuts } from './scenarios.ts'
import { NS } from './locale.ts'
import css from './ScenarioShortcuts.module.css'

/** Full slot props for the scenario-shortcuts list. */
export type ScenarioShortcutsProps = PropsRuntime<'conversation.composer.shortcuts'> & PropsLocale<typeof NS>

/** Leading outline glyph for each client-known skill; server-defined skills fall back to the generic skill icon. */
const SKILL_ICONS: Readonly<Record<string, ReactNode>> = {
  'zhidu-knowledge': <IconSearchOutlineMedium />,
  'gs-research-summary': <IconListPenOutlineMedium />,
  'juyuan-data': <IconDatabaseOutlineMedium />,
  'miaoxiang-data': <IconSparkleMedium />,
}

/**
 * Insert the chosen skill at the captured caret without submitting or replacing the draft.
 * @param props - owner lock/focus actions, standard input/resource actions, and locale.
 * @returns enabled scenario buttons, or null when the whole list is hidden.
 */
export function ScenarioShortcuts({
  locked, focusComposer, useInput, inputActions, useResource, t,
}: ScenarioShortcutsProps) {
  const setting = useResource<'gs-scenarios'>(SCENARIO_SHORTCUTS_ADDRESS).value
  const draft = useInput(state => state.draft)
  const occurrences = useInput(state => state.occurrences)
  const claim = useInput(state => state.claim)
  const items = useMemo(
    () => resolveScenarioShortcuts(setting, key => t(key)),
    [setting, t],
  )
  if (items.length === 0) return null

  const insert = (skill: string): void => {
    const span = inputActions.captureInsertion()
    const text = scenarioSkillInsertion({ draft, occurrences, ...(claim === undefined ? {} : { claim }) }, span, skill)
    if (inputActions.insertText(text, span)) focusComposer()
  }

  return <div className={css.shortcuts} role="group" aria-label={t('groupAria')}>
    {items.map(item => <Button
      key={item.id}
      size="sm"
      variant="outline"
      className={css.shortcut}
      icon={SKILL_ICONS[item.skill] ?? <IconSkillOutlineMedium />}
      disabled={locked}
      onMouseDown={(event) => { event.preventDefault() }}
      onClick={() => { insert(item.skill) }}
    ><span className={css.label}>{item.label}</span></Button>)}
  </div>
}
