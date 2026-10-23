/** Detect-to-clipboard selection mapping and real-shell insertion behavior. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionInputShell } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/facade.ts'
import { $selectDetectSpan } from '@deepseek-ai/dsh-client-ui-conversation/src/client/input/editor/span-map.ts'
import { scenarioSkillInsertion, type ScenarioInsertionInput } from '../src/client/insertion.ts'

const LONG = '@[Research notes](dsh-session:InNvdXJjZSI)'
const SECOND = '@second'
type Occurrence = InputState['occurrences'][number]

let occurrenceId = 0
function occurrence(offset: number, clipboardText: string): Occurrence {
  occurrenceId += 1
  return {
    occurrenceId, source: 'reference', ref: clipboardText, offset, length: clipboardText.length,
    label: 'Research notes', clipboardText,
  }
}

function input(
  draft: string,
  occurrences: readonly Occurrence[] = [],
  claim?: InputState['claim'],
): ScenarioInsertionInput {
  return { draft, occurrences, ...(claim === undefined ? {} : { claim }) }
}

const longAtStart = () => occurrence(0, LONG)
const secondAt = (offset: number) => occurrence(offset, SECOND)

it.each([
  { name: 'empty draft', value: input(''), start: 0, end: 0, expected: '/skill ' },
  { name: 'plain text with existing whitespace', value: input('left  right'), start: 5, end: 5, expected: '/skill' },
  { name: 'plain range selection', value: input('leftSELECTIONright'), start: 4, end: 13, expected: ' /skill ' },
  { name: 'before a long chip', value: input(LONG, [longAtStart()]), start: 0, end: 0, expected: '/skill ' },
  { name: 'after a long chip at draft end', value: input(LONG, [longAtStart()]), start: 1, end: 1, expected: ' /skill ' },
  {
    name: 'after a long chip before existing whitespace',
    value: input(`${LONG} next`, [longAtStart()]), start: 1, end: 1, expected: ' /skill',
  },
  {
    name: 'before a long chip after existing whitespace',
    value: input(`left ${LONG}`, [occurrence(5, LONG)]), start: 5, end: 5, expected: '/skill ',
  },
  {
    name: 'between long chips without existing whitespace',
    value: input(`${LONG}${SECOND}`, [longAtStart(), secondAt(LONG.length)]),
    start: 1, end: 1, expected: ' /skill ',
  },
  {
    name: 'between long chips with existing whitespace',
    value: input(`${LONG} ${SECOND}`, [longAtStart(), secondAt(LONG.length + 1)]),
    start: 2, end: 2, expected: '/skill ',
  },
  {
    name: 'range replacing the second chip preserves surrounding whitespace',
    value: input(`${LONG} ${SECOND} tail`, [longAtStart(), secondAt(LONG.length + 1)]),
    start: 2, end: 3, expected: '/skill',
  },
  {
    name: 'space inside a long reference does not suppress the required trailing space',
    value: input(`${LONG}abcdefghix`, [longAtStart()]), start: 10, end: 10, expected: ' /skill ',
  },
  {
    name: 'a leading command chip is included in the mapping',
    value: input(`/goal ${LONG} tail`, [occurrence(6, LONG)], { name: 'goal', token: '/goal ' }),
    start: 2, end: 3, expected: '/skill',
  },
])('inserts with clipboard-correct whitespace: $name', ({ value, start, end, expected }) => {
  expect(scenarioSkillInsertion(value, { start, end }, 'skill')).toBe(expected)
})

function shell(): SessionInputShell {
  return new SessionInputShell({
    actx: new Context(),
    defaultSink: vi.fn(),
    commandAttachments: {
      serialize: async () => [], release: () => {}, unsupportedNotice: () => '',
    },
  })
}

it('inserts beside a real long reference chip without joining the skill to following text', () => {
  const inputShell = shell()
  try {
    inputShell.setDraft({
      text: `${LONG}abcdefghix`,
      references: [{
        source: 'reference', ref: LONG, offset: 0, length: LONG.length,
        label: 'Research notes', clipboardText: LONG,
      }],
    })
    inputShell.editor.update(() => { $selectDetectSpan({ start: 10, end: 10 }) }, { discrete: true })
    const originalOccurrences = inputShell.snapshot.occurrences
    const span = inputShell.actions.captureInsertion()
    const insertion = scenarioSkillInsertion(inputShell.snapshot, span, 'skill')

    expect(insertion).toBe(' /skill ')
    expect(inputShell.actions.insertText(insertion, span)).toBe(true)
    expect(inputShell.snapshot.draft).toBe(`${LONG}abcdefghi /skill x`)
    expect(inputShell.snapshot.occurrences).toEqual(originalOccurrences)
  } finally { inputShell.dispose() }
})

it('rejects an insertion captured before a later real-shell draft revision', () => {
  const inputShell = shell()
  try {
    inputShell.setDraft('before')
    const span = inputShell.actions.captureInsertion()
    inputShell.setDraft('newer text')
    const insertion = scenarioSkillInsertion(inputShell.snapshot, span, 'skill')

    expect(inputShell.actions.insertText(insertion, span)).toBe(false)
    expect(inputShell.snapshot.draft).toBe('newer text')
  } finally { inputShell.dispose() }
})
