// @vitest-environment jsdom
/** User-visible configuration, lock/focus behavior, and revision-guarded skill insertion. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { InputActions, InputState, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { GsScenarioShortcutsSetting } from '../src/client/contract.ts'
import { ScenarioShortcuts, type ScenarioShortcutsProps } from '../src/client/ScenarioShortcuts.tsx'
import { zh } from '../src/client/locale.ts'

afterEach(() => { cleanup() })

interface FixtureOptions {
  readonly setting?: GsScenarioShortcutsSetting
  readonly draft?: string
  readonly occurrences?: InputState['occurrences']
  readonly claim?: InputState['claim']
  readonly span?: TokenSpan
  readonly locked?: boolean
  readonly inserted?: boolean
}

function mount(options: FixtureOptions = {}) {
  const draft = options.draft ?? ''
  const span = options.span ?? { start: draft.length, end: draft.length, draftRev: 0 }
  const focusComposer = vi.fn()
  const captureInsertion = vi.fn(() => span)
  const insertText = vi.fn(() => options.inserted ?? true)
  const setDraft = vi.fn()
  const submit = vi.fn()
  const inputActions: InputActions = {
    captureInsertion,
    insertText,
    setDraft,
    submit,
    persistDraft: vi.fn(),
    addAttachments: vi.fn(() => true),
    removeAttachment: vi.fn(),
    pruneAttachments: vi.fn(),
  }
  const input: InputState = {
    draft,
    attachmentIds: [],
    draftRev: span.draftRev,
    phase: options.claim === undefined ? 'plain' : 'claimed',
    occurrences: options.occurrences ?? [],
    ...(options.claim === undefined ? {} : { claim: options.claim }),
    queue: [],
  }
  const props = {
    locked: options.locked ?? false,
    focusComposer,
    useInput: <S,>(selector: (state: InputState) => S): S => selector(input),
    inputActions,
    useResource: () => ({ status: 'live', value: options.setting, failure: undefined }),
    t: makeTranslate(zh),
  } as ScenarioShortcutsProps
  const view = render(<ScenarioShortcuts {...props} />)
  return { view, focusComposer, captureInsertion, insertText, setDraft, submit, span }
}

describe('scenario configuration', () => {
  it.each([
    [zh.defaultZhidu, 'zhidu-knowledge'],
    [zh.defaultResearch, 'gs-research-summary'],
    [zh.defaultJuyuan, 'juyuan-data'],
    [zh.defaultEastMoney, 'miaoxiang-data'],
  ])('inserts only the default skill command for %s', (label, skill) => {
    const fixture = mount()
    expect(screen.getAllByRole('button')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(fixture.insertText).toHaveBeenCalledWith(`/${skill} `, fixture.span)
    expect(fixture.focusComposer).toHaveBeenCalledTimes(1)
    expect(fixture.setDraft).not.toHaveBeenCalled()
    expect(fixture.submit).not.toHaveBeenCalled()
  })

  it('renders a distinct visible outline icon ahead of every default label', () => {
    mount()
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(4)
    const glyphs = buttons.map((button) => {
      const svg = button.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg?.getAttribute('width')).toBe('16')
      return svg?.innerHTML
    })
    expect(new Set(glyphs).size).toBe(4)
  })

  it('uses custom labels and skills, hides item-off rows, and preserves the group name', () => {
    const fixture = mount({ setting: {
      enabled: true,
      items: [
        { id: 'custom-id', label: '服务端自定义', skill: 'custom-skill' },
        { id: 'hidden-id', label: '不可见', skill: 'hidden-skill', enabled: false },
      ],
    } })
    expect(screen.getByRole('group', { name: zh.groupAria })).toBeDefined()
    expect(screen.queryByRole('button', { name: '不可见' })).toBeNull()
    const custom = screen.getByRole('button', { name: '服务端自定义' })
    expect(custom.querySelector('svg')).not.toBeNull()
    fireEvent.click(custom)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(fixture.insertText).toHaveBeenCalledWith('/custom-skill ', fixture.span)
  })

  it.each([
    { name: 'null', setting: null },
    { name: 'global off', setting: { enabled: false, items: [] } },
    { name: 'all items off', setting: { enabled: true, items: [{ id: 'off', label: '隐藏', skill: 'off', enabled: false }] } },
  ])('renders nothing for $name', ({ setting }) => {
    const { view } = mount({ setting })
    expect(view.container.innerHTML).toBe('')
  })

  it('updates from defaults to a newly fetched server list', () => {
    const setting: { current: GsScenarioShortcutsSetting | undefined } = { current: undefined }
    const props = {
      locked: false,
      focusComposer: vi.fn(),
      useInput: <S,>(selector: (state: InputState) => S): S => selector({
        draft: '', attachmentIds: [], draftRev: 0, phase: 'plain', occurrences: [], queue: [],
      }),
      inputActions: { captureInsertion: vi.fn(), insertText: vi.fn() },
      useResource: () => ({ status: 'live', value: setting.current, failure: undefined }),
      t: makeTranslate(zh),
    } as ScenarioShortcutsProps
    const view = render(<ScenarioShortcuts {...props} />)
    expect(screen.getByRole('button', { name: zh.defaultZhidu })).toBeDefined()
    setting.current = { enabled: true, items: [{ id: 'new', label: '新配置', skill: 'new-skill' }] }
    act(() => { view.rerender(<ScenarioShortcuts {...props} />) })
    expect(screen.getByRole('button', { name: '新配置' })).toBeDefined()
    expect(screen.queryByRole('button', { name: zh.defaultZhidu })).toBeNull()
  })
})

describe('composer interaction', () => {
  it('maps detect selection through real occurrence offsets before inserting', () => {
    const fixture = mount({
      draft: '@first@second',
      occurrences: [
        { occurrenceId: 1, source: 'reference', ref: '@first', offset: 0, length: 6, label: 'first', clipboardText: '@first' },
        { occurrenceId: 2, source: 'reference', ref: '@second', offset: 6, length: 7, label: 'second', clipboardText: '@second' },
      ],
      span: { start: 1, end: 1, draftRev: 7 },
    })
    fireEvent.click(screen.getByRole('button', { name: zh.defaultZhidu }))
    expect(fixture.captureInsertion).toHaveBeenCalledTimes(1)
    expect(fixture.insertText).toHaveBeenCalledWith(' /zhidu-knowledge ', fixture.span)
    expect(fixture.focusComposer).toHaveBeenCalledTimes(1)
    expect(fixture.setDraft).not.toHaveBeenCalled()
    expect(fixture.submit).not.toHaveBeenCalled()
  })

  it('does not focus when the input action rejects the captured revision', () => {
    const fixture = mount({ inserted: false })
    fireEvent.click(screen.getByRole('button', { name: zh.defaultZhidu }))
    expect(fixture.insertText).toHaveBeenCalledTimes(1)
    expect(fixture.focusComposer).not.toHaveBeenCalled()
  })

  it('disables every button while locked', () => {
    const fixture = mount({ locked: true })
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(4)
    for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(buttons[0]!)
    expect(fixture.captureInsertion).not.toHaveBeenCalled()
    expect(fixture.insertText).not.toHaveBeenCalled()
    expect(fixture.focusComposer).not.toHaveBeenCalled()
  })

  it('keeps editor focus on mousedown', () => {
    const fixture = mount()
    const button = screen.getByRole('button', { name: zh.defaultZhidu })
    expect(fireEvent.mouseDown(button)).toBe(false)
    expect(fixture.captureInsertion).not.toHaveBeenCalled()
  })
})
