/** Requested-model disclosure, acknowledgement, handwriting, and archived PDF download. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: the ui-conversation SlotMap merge (the input.activity seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the ui-session standard-prop merges (sessionId, useSessions).
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { GsModelRiskView } from './contract.ts'
import { isRevisionConflict, ModelRiskRequestError, type ModelRiskApi } from './api.ts'
import { NS } from './locale.ts'
import css from './ModelRisk.module.css'
import type { ModelRiskController } from './controller.ts'

/** Canvas backing-store size; strokes record normalized coordinates. */
const CANVAS_WIDTH = 600
const CANVAS_HEIGHT = 150
/** Point cap per stroke, bounding one signature's upload size. */
const STROKE_POINT_LIMIT = 2000
/** Injected controller shared with the model-selection authorization guard. */
export interface ModelRiskInjected { readonly controller: ModelRiskController }

/** Session-scoped disclosure host; it draws no composer icon. */
export type ModelRiskActivityProps = PropsRuntime<'conversation.input.activity'> & PropsLocale<typeof NS> & InjectFace<ModelRiskInjected>

/**
 * Present the pending choice's disclosure in its owning session.
 * @param props - session identity, controller, and localized copy.
 * @returns the current authorization dialog.
 */
export function ModelRiskActivity({ sessionId, controller, t }: ModelRiskActivityProps) {
  const subscribe = useCallback((listener: () => void) => controller.requests.subscribe(listener), [controller])
  const snapshot = useCallback(() => controller.requests.getSnapshot(), [controller])
  const request = useSyncExternalStore(subscribe, snapshot)
  useEffect(() => () => {
    if (controller.requests.getSnapshot()?.sessionId === sessionId) controller.close()
  }, [controller, sessionId])
  if (request === null || request.sessionId !== sessionId) return null
  return <ModelRiskDialog key={request.selection.provider + '/' + request.selection.model} selection={request.selection}
    {...controller.api} t={t} onClose={() => { controller.close() }} onSigned={() => { controller.signed() }} />
}

/** Props of the requested-model disclosure dialog. */
export type ModelRiskDialogProps = ModelRiskApi & PropsLocale<typeof NS> & {
  readonly selection: ModelSelection
  readonly onClose: () => void
  readonly onSigned: () => void
}

function normalizedPoint(event: ReactPointerEvent<HTMLCanvasElement>): [number, number] {
  const rect = event.currentTarget.getBoundingClientRect()
  const x = rect.width === 0 ? 0 : (event.clientX - rect.left) / rect.width
  const y = rect.height === 0 ? 0 : (event.clientY - rect.top) / rect.height
  return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))]
}

function inkContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  // currentColor tracks the sheet's label token, keeping ink legible in both palettes.
  ctx.strokeStyle = 'currentColor'
  ctx.fillStyle = 'currentColor'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3
  return ctx
}

/**
 * Read and sign the disclosure for a requested model before authorizing its selection.
 * @param props - requested selection, policy API, completion callbacks, and locale.
 * @returns the disclosure dialog with handwriting or the archived PDF action.
 */
export function ModelRiskDialog({ selection, t, readStatus, sign, downloadPdf, onClose, onSigned }: ModelRiskDialogProps) {
  const providerId = selection.provider
  const modelId = selection.model
  const [view, setView] = useState<GsModelRiskView>()
  const [statusError, setStatusError] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [hasSignature, setHasSignature] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<number[][][]>([])
  const activePointer = useRef<number | null>(null)

  const clearSignature = () => {
    setHasSignature(false)
    strokes.current = []
    activePointer.current = null
    canvas.current?.getContext('2d')?.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT)
  }

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    void readStatus({ providerId, modelId }).then((value) => {
      if (cancelled) return
      setView(value)
      setStatusError('')
      if (!value.required) { onSigned(); onClose() }
      else if (value.consentId !== undefined) onSigned()
    }).catch((cause: unknown) => {
      if (cancelled) return
      const message = cause instanceof Error && cause.message !== '' ? cause.message : t('loadFailed')
      setStatusError(message)
      setError(message)
    }).finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [providerId, modelId, readStatus, t])
  const signed = view?.consentId !== undefined
  const closeDialog = () => { if (!busy) onClose() }

  const openDialog = () => {
    setError('')
    setBusy(true)
    setAcknowledged(false)
    clearSignature()
    void readStatus({ providerId, modelId }).then((fresh) => {
      setStatusError('')
      if (!fresh.required) {
        // The route stopped requiring a signature: hide rather than show a stale dialog.
        setView(undefined)
        onSigned()
        onClose()
        return
      }
      setView(fresh)
      if (fresh.consentId !== undefined) onSigned()
    }).catch((cause: unknown) => {
      const message = cause instanceof Error && cause.message !== '' ? cause.message : t('loadFailed')
      setStatusError(message)
      setError(message)
    }).finally(() => { setBusy(false) })
  }

  const submitSign = () => {
    /* v8 ignore next -- the sign button is disabled while a submission is in flight; this backs programmatic dispatch */
    if (busy || view?.required !== true || statusError !== '') return
    setBusy(true)
    setError('')
    void sign({
      providerId,
      modelId,
      revision: view.revision,
      acknowledged,
      signature: strokes.current,
    }).then((fresh) => {
      setView(fresh)
      if (fresh.consentId !== undefined) onSigned()
      else setError(t('signFailed'))
    })
      .catch((cause: unknown) => {
        if (cause instanceof ModelRiskRequestError && cause.status === 400 && cause.message === '请填写姓名、邮箱并确认已阅读') {
          setError(t('serverUpdateRequired'))
          return
        }
        if (!isRevisionConflict(cause)) {
          setError(cause instanceof Error && cause.message !== '' ? cause.message : t('signFailed'))
          return
        }
        // The protocol moved under the open form: reload the current text and ask for a fresh signature.
        return readStatus({ providerId, modelId }).then((fresh) => {
          setView(fresh.required ? fresh : undefined)
          setAcknowledged(false)
          clearSignature()
          if (!fresh.required) { onSigned(); onClose(); return }
          if (fresh.consentId !== undefined) { onSigned(); return }
          setError(t('revisionChanged'))
        }).catch(() => { setError(t('loadFailed')) })
      })
      .finally(() => { setBusy(false) })
  }

  const download = () => {
    const consentId = view?.consentId
    /* v8 ignore next -- the download button renders only for a signed view and is disabled while busy */
    if (consentId === undefined || busy) return
    setBusy(true)
    setError('')
    void downloadPdf({ consentId }).then((result) => {
      const data = Uint8Array.from(atob(result.pdfBase64), character => character.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `model-risk-${consentId}.pdf`
      anchor.click()
      setTimeout(() => { URL.revokeObjectURL(url) }, 60_000)
    }).catch((cause: unknown) => {
      setError(cause instanceof Error && cause.message !== '' ? cause.message : t('downloadFailed'))
    }).finally(() => { setBusy(false) })
  }

  const mail = view?.mailStatus === undefined ? ''
    : view.mailStatus === 'sent' ? t('mailSent')
      : view.mailStatus === 'failed' ? t('mailFailed')
        : t('mailPending')
  const canSign = !busy && statusError === '' && view?.required === true && acknowledged && hasSignature

  return <Modal
    open={true}
    onClose={closeDialog}
    title={view?.title ? view.title : t('loadingTitle')}
    closeLabel={t('close')}
    className={css.dialog as string}
    onKeyDownCapture={(event) => {
      // Text inputs keep their Escape; only non-input targets close the dialog.
      if (event.key === 'Escape' && event.target instanceof HTMLInputElement) {
        event.stopPropagation()
      }
    }}
  >
    {busy && view === undefined && <p role="status">{t('loading')}</p>}
    <p className={css.model}>{t('modelLabel')}{providerId}/{modelId}</p>
    {view?.required === true && <div className={css.text}>{view.text}</div>}
    {error !== '' && <p role="alert" className={css.error}>{error}</p>}
    {statusError !== '' && <p>
      <button type="button" className={css.action} disabled={busy} onClick={openDialog}>{t('retry')}</button>
    </p>}
    {view?.required !== true ? null : signed ? <>
      <p>{statusError === '' ? t('signedReady') : ''}{mail}</p>
      <p>
        <button type="button" className={css.action} disabled={busy} onClick={download}>
          {busy ? t('working') : t('downloadPdf')}
        </button>
      </p>
    </> : <>
      <p><label className={css.acknowledge}>
        <input type="checkbox" checked={acknowledged} disabled={busy}
          onChange={(event) => { setAcknowledged(event.target.checked) }} />
        {t('acknowledge')}
      </label></p>
      <p className={css.signaturePrompt}>{t('signaturePrompt')}</p>
      <canvas
        ref={canvas}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        aria-label={t('signatureAria')}
        className={css.canvas}
        onPointerDown={(event) => {
          if (busy || activePointer.current !== null) return
          event.currentTarget.setPointerCapture(event.pointerId)
          activePointer.current = event.pointerId
          const point = normalizedPoint(event)
          strokes.current.push([point])
          setHasSignature(true)
          // A tap without movement still leaves a visible dot.
          const ctx = inkContext(event.currentTarget)
          if (ctx !== null) {
            ctx.beginPath()
            ctx.arc(point[0] * CANVAS_WIDTH, point[1] * CANVAS_HEIGHT, ctx.lineWidth / 2, 0, Math.PI * 2)
            ctx.fill()
          }
        }}
        onPointerMove={(event) => {
          if (busy || activePointer.current !== event.pointerId) return
          const stroke = strokes.current.at(-1)
          /* v8 ignore next -- pointerdown pushes the active stroke when the pointer id is captured */
          if (stroke === undefined) return
          if (stroke.length >= STROKE_POINT_LIMIT) return
          const previous = stroke.at(-1)
          const point = normalizedPoint(event)
          stroke.push(point)
          const ctx = inkContext(event.currentTarget)
          const prevX = previous?.[0]
          const prevY = previous?.[1]
          if (ctx !== null && prevX !== undefined && prevY !== undefined) {
            ctx.beginPath()
            ctx.moveTo(prevX * CANVAS_WIDTH, prevY * CANVAS_HEIGHT)
            ctx.lineTo(point[0] * CANVAS_WIDTH, point[1] * CANVAS_HEIGHT)
            ctx.stroke()
          }
        }}
        onPointerUp={() => { activePointer.current = null }}
        onPointerCancel={() => { activePointer.current = null }}
      />
      <p className={css.actions}>
        <button type="button" className={css.action} disabled={busy} onClick={clearSignature}>
          {t('clearSignature')}
        </button>
        <button type="button" className={clsx(css.action, css.primary)} disabled={!canSign} onClick={submitSign}>
          {busy ? t('working') : t('sign')}
        </button>
      </p>
    </>}
  </Modal>
}
