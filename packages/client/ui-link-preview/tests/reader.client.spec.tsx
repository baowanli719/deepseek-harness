// @vitest-environment jsdom
/** Markdown sources remain inert, and reader lifetimes abort obsolete requests. */
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { Reader, ReaderTitle, QuoteNotice, type ReaderProps } from '../src/client/Reader.tsx'
import type { LinkPreviewResult } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function props(read: ReaderProps['read'], params: { provider: string; url: string } | null = {
  provider: 'test', url: 'https://source.test/file',
}, bindCommands = (_commands: { refresh: () => void }) => () => {}): ReaderProps {
  return {
    t: makeTranslate(zh), read, useProviders: (selector: (value: number) => unknown) => selector(0),
    reportQuote: vi.fn(), useInput: (selector: (value: { phase: 'plain' }) => unknown) => selector({ phase: 'plain' }),
    inputActions: { captureInsertion: () => ({ start: 4, end: 4, draftRev: 1 }), insertText: vi.fn(() => true) },
    useTabInfo: () => ({ tab: {
      title: 'Source title', visible: true, navigation: { params: params ?? undefined },
      actions: { bindCommands },
    } }),
  } as never
}

it('keeps HTML inert, exposes literal source text, and reloads on demand', async () => {
  const read = vi.fn<ReaderProps['read']>(async () => ({
    status: 'ok', document: { title: '制度名称', content: '<script>alert(1)</script>\n原文', truncated: true },
  }))
  const view = render(<Reader {...props(read)} />)
  expect(await screen.findByText('制度名称')).toBeTruthy()
  expect(screen.getByText(zh.truncated)).toBeTruthy()
  expect(view.container.querySelector('script')).toBeNull()
  expect(view.container.textContent).toContain('<script>alert(1)</script>')
  fireEvent.click(screen.getByText(zh.raw))
  expect(view.container.querySelector('pre')?.textContent).toBe('<script>alert(1)</script>\n原文')
  fireEvent.click(screen.getByText(zh.formatted))
  expect(view.container.querySelector('pre')).toBeNull()
  fireEvent.click(screen.getByText(zh.reload))
  await waitFor(() => { expect(read).toHaveBeenCalledTimes(2) })
})

it('formats headings, tables, quoted passages, reference links and footnotes', async () => {
  const content = '# 年休假\n\n> 连续工作满一年\n\n| 工龄 | 天数 |\n| --- | --- |\n| 十年 | 10 |\n\n[出处][policy] 说明[^note]\n\n[policy]: https://source.test/original\n[^note]: 按工作日计算\n\n[unsafe](javascript:alert(1))'
  const view = render(<Reader {...props(async () => ({ status: 'ok', document: { title: null, content, truncated: false } }))} />)
  expect(await screen.findByRole('heading', { name: '年休假' })).toBeTruthy()
  expect(screen.getByRole('table').textContent).toContain('十年')
  expect(view.container.querySelector('blockquote')?.textContent).toContain('连续工作满一年')
  expect(screen.getByRole('link', { name: '出处' }).getAttribute('href')).toBe('https://source.test/original')
  expect(view.container.querySelector('section[role="doc-endnotes"]')?.textContent ?? view.container.textContent).toContain('按工作日计算')
  expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull()
})

it('inserts only a selection from this source with its title and URL, without submitting', async () => {
  const readerProps = props(async () => ({ status: 'ok', document: { title: '制度 [草稿]', content: '原文第一段\n\n原文第二段', truncated: false } }))
  const insertText = vi.fn(() => true)
  readerProps.inputActions.insertText = insertText
  const view = render(<Reader {...readerProps} />)
  const passage = await screen.findByText('原文第一段')
  const quote = screen.getByRole('button', { name: zh.quote })
  expect(quote).toHaveProperty('disabled', true)
  const selected = document.getSelection()!
  const range = document.createRange()
  const select = (element: Node): void => {
    act(() => {
      range.selectNodeContents(element)
      selected.removeAllRanges()
      selected.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
  }
  select(screen.getByRole('heading'))
  expect(quote).toHaveProperty('disabled', true)
  select(passage)
  expect(quote).toHaveProperty('disabled', false)
  expect(fireEvent.mouseDown(quote)).toBe(false)
  fireEvent.click(quote)
  expect(insertText).toHaveBeenCalledWith(
    '\n\n> 原文第一段\n\n[制度 \\[草稿\\]](<https://source.test/file>)\n\n', { start: 4, end: 4, draftRev: 1 },
  )
  expect(readerProps.reportQuote).toHaveBeenCalledWith(true)
  act(() => { selected.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) })
  expect(quote).toHaveProperty('disabled', true)
  view.unmount()
})

it('reports refused insertions and disables quoting while the composer submits', async () => {
  const readerProps = props(async () => ({ status: 'ok', document: { title: null, content: '可引用原文', truncated: false } }))
  readerProps.inputActions.insertText = () => false
  const view = render(<Reader {...readerProps} />)
  const text = await screen.findByText('可引用原文')
  act(() => {
    const range = document.createRange()
    range.selectNodeContents(text)
    const selected = document.getSelection()!
    selected.removeAllRanges()
    selected.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  fireEvent.click(screen.getByRole('button', { name: zh.quote }))
  expect(readerProps.reportQuote).toHaveBeenCalledWith(false)
  expect(screen.getByText('可引用原文')).toBeTruthy()
  view.rerender(<Reader {...readerProps} useInput={selector => selector({ phase: 'submitting' } as never)} />)
  expect(screen.getByRole('button', { name: zh.quote })).toHaveProperty('disabled', true)
})

it('hosts quote feedback independently of the source tab and dismisses completed notices', () => {
  const dismiss = vi.fn()
  const noticeProps: Parameters<typeof QuoteNotice>[0] = { t: makeTranslate(zh), dismissQuote: dismiss,
    useQuoteNotice: selector => selector(null),
  }
  const view = render(<QuoteNotice {...noticeProps} />)
  expect(screen.queryByRole('alert')).toBeNull()
  view.rerender(<QuoteNotice {...noticeProps} useQuoteNotice={selector => selector({ seq: 1, inserted: true })} />)
  expect(screen.getByRole('alert').textContent).toBe(zh.quoted)
  view.rerender(<QuoteNotice {...noticeProps} useQuoteNotice={selector => selector({ seq: 2, inserted: false })} />)
  expect(screen.getByRole('alert').textContent).toBe(zh.quoteFailed)
  view.unmount()
})

it.each(['unauthorized', 'forbidden', 'source-mismatch', 'not-found', 'unavailable', 'failed'] as const)('shows localized %s failures', async (status) => {
  render(<Reader {...props(async () => ({ status }))} />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh[status])
})

it('aborts closed readers and ignores a late result', async () => {
  let signal: AbortSignal | undefined
  let complete: ((value: LinkPreviewResult) => void) | undefined
  const view = render(<Reader {...props((_provider, _url, lifetime) => {
    signal = lifetime
    return new Promise((resolve) => { complete = resolve })
  })} />)
  expect(screen.getByRole('status').getAttribute('aria-label')).toBe(zh.loading)
  view.unmount()
  expect(signal?.aborted).toBe(true)
  complete?.({ status: 'ok', document: { title: 'late', content: 'late', truncated: false } })
  await Promise.resolve()
  expect(screen.queryByText('late')).toBeNull()
})

it('retains readable text after a failed reload and clears it when access expires', async () => {
  const read = vi.fn<ReaderProps['read']>()
    .mockResolvedValueOnce({ status: 'ok', document: { title: '制度', content: '原文保留', truncated: false } })
    .mockResolvedValueOnce({ status: 'failed' })
    .mockResolvedValueOnce({ status: 'unauthorized' })
  render(<Reader {...props(read)} />)
  await screen.findByText('原文保留')
  fireEvent.click(screen.getByText(zh.reload))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh.failed)
  expect(screen.getByText('原文保留')).toBeTruthy()
  fireEvent.click(screen.getByText(zh.reload))
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.unauthorized) })
  expect(screen.queryByText('原文保留')).toBeNull()
})

it('reports missing restored source identity and network failures', async () => {
  const read = vi.fn<ReaderProps['read']>().mockRejectedValue(new Error('offline'))
  const view = render(<Reader {...props(read, null)} />)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', zh.unavailable)
  expect(read).not.toHaveBeenCalled()
  view.rerender(<Reader {...props(read)} />)
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh.failed) })
})

it('ignores an obsolete source and binds the Sidebar refresh command', async () => {
  let complete: ((value: LinkPreviewResult) => void) | undefined
  let refresh: (() => void) | undefined
  const bind = (commands: { refresh: () => void }) => { refresh = commands.refresh; return () => {} }
  const read = vi.fn<ReaderProps['read']>()
    .mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    .mockResolvedValue({ status: 'ok', document: { title: null, content: 'new source', truncated: false } })
  const view = render(<Reader {...props(read)} />)
  view.rerender(<Reader {...props(read, { provider: 'test', url: 'https://source.test/other' }, bind)} />)
  await screen.findByText('new source')
  await act(async () => {
    complete?.({ status: 'ok', document: { title: 'old source', content: 'old source', truncated: false } })
  })
  expect(screen.queryByText('old source')).toBeNull()
  act(() => { refresh?.() })
  await waitFor(() => { expect(read).toHaveBeenCalledTimes(3) })
  render(<ReaderTitle {...props(read)} />)
  expect(screen.getByText('Source title')).toBeTruthy()
})
