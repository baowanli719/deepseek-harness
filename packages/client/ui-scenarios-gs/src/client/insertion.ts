/** Plain-text insertion construction for scenario skill commands. */
import type { InputState, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'

/** Clipboard draft and the atomic chips whose detect lengths differ from their clipboard lengths. */
export type ScenarioInsertionInput = Pick<InputState, 'draft' | 'occurrences' | 'claim'>
type Chip = Pick<ScenarioInsertionInput['occurrences'][number], 'offset' | 'length'>

function clipboardOffsetOfDetectOffset(detectOffset: number, chips: readonly Chip[]): number {
  let expansion = 0
  for (const chip of chips) {
    const detectStart = chip.offset - expansion
    if (detectOffset <= detectStart) break
    expansion += chip.length - 1
  }
  return detectOffset + expansion
}

/**
 * Build one skill-token insertion with only the whitespace needed at its two neighbors.
 * @param input - clipboard draft and its command/reference chip projections.
 * @param selection - captured half-open editor selection in detect coordinates.
 * @param skill - skill name without the leading slash.
 * @returns text to insert through the revision-guarded input action.
 */
export function scenarioSkillInsertion(
  input: ScenarioInsertionInput,
  selection: Pick<TokenSpan, 'start' | 'end'>,
  skill: string,
): string {
  const command = input.claim?.token.trimEnd()
  const chips: readonly Chip[] = command === undefined
    ? input.occurrences
    : [{ offset: 0, length: command.length }, ...input.occurrences]
  const start = clipboardOffsetOfDetectOffset(selection.start, chips)
  const end = clipboardOffsetOfDetectOffset(selection.end, chips)
  const before = start > 0 && !/\s/u.test(input.draft.charAt(start - 1)) ? ' ' : ''
  const after = end >= input.draft.length || !/\s/u.test(input.draft.charAt(end)) ? ' ' : ''
  return `${before}/${skill}${after}`
}
