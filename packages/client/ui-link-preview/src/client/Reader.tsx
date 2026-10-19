/** Markdown source reader with a literal-text view; remote HTML remains inert. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconLinkOutlineRegular, IconWarningOutlineRegular, MarkdownText, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LinkPreviewDocument, LinkPreviewResult } from './contract.ts'
import type { NS } from './locales.ts'
import css from './Reader.module.css'

/** Reader callbacks and registration revisions bound by the Slot renderer. */
export interface ReaderInjected {
  readonly hooks: {
    readonly providers: {
      getSnapshot: () => number
      subscribe: (listener: () => void) => () => void
    }
  }
  readonly read: (provider: string, url: string, signal: AbortSignal) => Promise<LinkPreviewResult>
  readonly reportQuote: (inserted: boolean) => void
}
export type ReaderProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<typeof NS> & InjectFace<ReaderInjected>

type ReadState = {
  readonly source: string
  readonly document?: LinkPreviewDocument
} & (
  | { readonly phase: 'loading' }
  | { readonly phase: 'loaded'; readonly document: LinkPreviewDocument }
  | { readonly phase: 'failed'; readonly failure: Exclude<LinkPreviewResult['status'], 'ok'> }
)

/** @param props - source identity and provider capabilities. @returns localized Markdown source reader. */
export function Reader({ useTabInfo, useProviders, useInput, inputActions, read, reportQuote, t }: ReaderProps) {
  const { tab } = useTabInfo()
  const params = tab.navigation.params
  const provider = params !== undefined && 'provider' in params ? params.provider : undefined
  const url = params !== undefined && 'provider' in params ? params.url : undefined
  const providers = useProviders(value => value)
  const inputPhase = useInput(value => value.phase)
  const contentRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState('')
  const [revision, setRevision] = useState(0)
  const [raw, setRaw] = useState(false)
  const labels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: {
      codeLabel: t('code'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap'),
    } },
    footnotes: t('footnotes'),
  }), [t])
  const source = JSON.stringify([provider, url])
  const [state, setState] = useState<ReadState>({ source, phase: 'loading' })
  const current: ReadState = state.source === source ? state : { source, phase: 'loading' }
  useEffect(() => {
    setSelection('')
    const element = contentRef.current
    if (element === null || !tab.visible) return
    const owner = element.ownerDocument
    const update = (): void => {
      const selected = owner.getSelection()
      setSelection(selected !== null && element.contains(selected.anchorNode) && element.contains(selected.focusNode)
        ? selected.toString().trim() : '')
    }
    owner.addEventListener('selectionchange', update)
    return () => { owner.removeEventListener('selectionchange', update) }
  }, [current.document, source, raw, tab.visible])
  useEffect(() => {
    const controller = new AbortController()
    setState(previous => ({ source, phase: 'loading', ...(previous.source === source && previous.document !== undefined
      ? { document: previous.document } : {}) }))
    const settle = (result: LinkPreviewResult): void => {
      if (controller.signal.aborted) return
      setState(previous => ({ source,
        ...(result.status === 'ok' ? { phase: 'loaded', document: result.document } : { phase: 'failed', failure: result.status,
          ...(result.status === 'failed' && previous.source === source && previous.document !== undefined
            ? { document: previous.document } : {}) }),
      }))
    }
    if (provider === undefined || url === undefined) {
      settle({ status: 'unavailable' })
      return () => { controller.abort() }
    }
    void read(provider, url, controller.signal).then(settle).catch(() => { settle({ status: 'failed' }) })
    return () => { controller.abort() }
  }, [provider, url, source, providers, read, revision])
  useEffect(() => tab.actions.bindCommands({ refresh: () => { setRevision(value => value + 1) } }), [tab.actions])
  return <section className={css.root} data-link-preview>
    <header className={css.header}>
      <h2>{current.document?.title ?? t('title')}</h2>
      <Button size="sm" disabled={current.phase === 'loading'} onClick={() => { setRevision(value => value + 1) }}>{t('reload')}</Button>
    </header>
    {current.phase === 'failed' && <div className={current.document === undefined ? css.center : css.notice}
      role="alert">{t(current.failure)}</div>}
    {current.document !== undefined && url !== undefined ? <>
      {current.document.truncated && <p className={css.notice} role="status">{t('truncated')}</p>}
      <div className={css.toolbar}>
        <Button size="sm" aria-pressed={raw} onClick={() => { setRaw(value => !value) }}>{raw ? t('formatted') : t('raw')}</Button>
        <Button size="sm" disabled={selection === '' || inputPhase !== 'plain'}
          onMouseDown={(event) => { event.preventDefault() }} onClick={() => {
            const title = (current.document?.title ?? t('title')).replace(/\s+/gu, ' ').replace(/[\\`*_[\]<>]/gu, '\\$&')
            const link = url.replace(/[<>\s\\]/gu, encodeURIComponent)
            const quote = `\n\n> ${selection.replace(/\n/gu, '\n> ')}\n\n[${title}](<${link}>)\n\n`
            reportQuote(inputActions.insertText(quote, inputActions.captureInsertion()))
          }}>{t('quote')}</Button>
      </div>
      <div className={css.content} ref={contentRef}>
        {raw ? <pre className={css.raw}>{current.document.content}</pre>
          : <MarkdownText text={current.document.content} labels={labels} />}
      </div>
    </> : current.phase === 'loading'
      && <div className={css.center} role="status" aria-label={t('loading')}><StateDot state="ongoing" size={28} /></div>}
  </section>
}

/** Shared quote feedback survives closing its source tab. */
export interface QuoteNoticeInjected {
  readonly hooks: { quoteNotice: {
    getSnapshot: () => { readonly seq: number; readonly inserted: boolean } | null
    subscribe: (listener: () => void) => () => void
  } }
  readonly dismissQuote: () => void
}

/** @param props - shared quote outcome and localized copy. @returns transient insertion feedback. */
export function QuoteNotice({ useQuoteNotice, dismissQuote, t }: InjectFace<QuoteNoticeInjected> & PropsLocale<typeof NS>) {
  const notice = useQuoteNotice(value => value)
  if (notice === null) return null
  return <Toast key={notice.seq} text={t(notice.inserted ? 'quoted' : 'quoteFailed')}
    {...notice.inserted ? { tone: 'success' as const } : { icon: <IconWarningOutlineRegular /> }} onDone={dismissQuote} />
}

/** @param props - current Sidebar tab. @returns link icon and saved title. */
export function ReaderTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  const { tab } = useTabInfo()
  return <><IconLinkOutlineRegular />{tab.title}</>
}
