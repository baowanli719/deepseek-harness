/** Server policy decoration at the trailing edge of one model list row. */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelRiskApi } from './api.ts'
import type { GsModelRiskView } from './contract.ts'
import { NS } from './locale.ts'
import css from './ModelRisk.module.css'

/**
 * Show a lock for unsigned models, an open lock for signed models, and none for trusted models.
 * @param props - row selection, policy API, and localized copy.
 * @returns a non-interactive decoration inside the selectable row.
 */
export function ModelRiskBadge({ selection, readStatus, t }: Pick<ModelRiskApi, 'readStatus'> & { selection: ModelSelection } & PropsLocale<typeof NS>) {
  const [view, setView] = useState<GsModelRiskView>()
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      void readStatus({ providerId: selection.provider, modelId: selection.model }).then((value) => {
        if (!cancelled) { setView(value); setUnavailable(false) }
      }).catch((cause: unknown) => {
        // Keep an actionable row while the policy service is temporarily unavailable.
        void cause
        if (!cancelled) setUnavailable(true)
      })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { cancelled = true; window.removeEventListener('focus', refresh) }
  }, [selection.provider, selection.model, readStatus])
  if (!unavailable && view?.required !== true) return null
  const signed = !unavailable && view?.consentId !== undefined
  const title = t(unavailable ? 'lockTitleUnavailable' : signed ? 'lockTitleSigned' : 'lockTitleUnsigned')
  return <span className={clsx(css.lock, signed ? css.signed : css.unsigned)} role="img" aria-label={title} title={title}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d={signed ? 'M8 10V6a4 4 0 018-1' : 'M8 10V6a4 4 0 018 0v4'} />
      <path d="M12 14v3" />
    </svg>
  </span>
}
