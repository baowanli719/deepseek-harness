/** gsclaw account identity in the sidebar Settings launcher seat. */
import { useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { Menu, IconSettingsOutlineMedium, IconSkillOutlineMedium, IconInfoOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Account.module.css'
import { zh, en, type Key } from './locales.ts'

const NS = 'gs.account'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'gs.account': Key
  }
}

interface User { readonly displayName: string; readonly role: string }
interface Session { readonly status: 'signed-in' | 'signed-out'; readonly user?: User }

async function readSession(): Promise<Session> {
  const response = await fetch('api/gs-server/session', {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`account request failed (${response.status})`)
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid account response')
  const row = value as Record<string, unknown>
  if (row.status === 'signed-out') return { status: 'signed-out' }
  if (row.status !== 'signed-in' || typeof row.user !== 'object' || row.user === null) {
    throw new Error('invalid account response')
  }
  const user = row.user as Record<string, unknown>
  if (typeof user.displayName !== 'string' || typeof user.role !== 'string') throw new Error('invalid account response')
  return { status: 'signed-in', user: { displayName: user.displayName, role: user.role } }
}

async function logout(): Promise<void> {
  const response = await fetch('api/gs-server/logout', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) throw new Error(`logout failed (${response.status})`)
}

type AccountProps = PropsRuntime<'settings.launcher'> & PropsLocale<typeof NS>

function AccountLauncher({ wide, openSettings, openSection, t }: AccountProps) {
  const [session, setSession] = useState<Session>()
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    void readSession().then((value) => { if (active) setSession(value) }).catch(() => {})
    return () => { active = false }
  }, [])
  const user = session?.status === 'signed-in' ? session.user : undefined
  const name = user?.displayName ?? (session === undefined ? t('loading') : t('signedOut'))
  const role = user?.role === undefined ? '' : /^(admin|administrator)$/iu.test(user.role)
    ? t('administrator') : user.role
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '?'
  return <>
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      side="top"
      portal
      autoFocus
      selection="fill"
      items={[
        { id: 'settings', label: t('settings'), icon: <IconSettingsOutlineMedium size={16} /> },
        { id: 'skills', label: t('skills'), icon: <IconSkillOutlineMedium size={16} /> },
        { id: 'about', label: t('about'), icon: <IconInfoOutlineMedium size={16} /> },
        { type: 'separator', id: 'account-separator' },
        { id: 'logout', label: t('logout'), danger: true },
      ]}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'settings') openSettings()
        else if (id === 'skills') { if (openSection) openSection('gs-skills'); else openSettings() }
        else if (id === 'about') { if (openSection) openSection('gs-about'); else openSettings() }
        else if (id === 'logout') void logout().then(() => {
          setSession({ status: 'signed-out' })
          setFailed(false)
        }).catch(() => { setFailed(true) })
      }}
      anchor={<button type="button" className={`${css.trigger} ${wide ? '' : css.rail}`}
        aria-label={t('open')} aria-haspopup="menu" aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}>
        <span className={css.avatar} aria-hidden="true">{initial}</span>
        {wide && <span className={css.identity}><strong>{name}</strong>{role !== '' && <small>{role}</small>}</span>}
      </button>}
    />
    {failed && <span className={css.error} role="alert">{t('logoutFailed')}</span>}
  </>
}

function AboutSection({ t, renderSlot }: PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & PropsRenderSlots<'gs.about.brand.mark'>) {
  const version = process.env.DSH_CLIENT_VERSION
  return <section className={css.about}>
    <header className={css.product}>
      {renderSlot('gs.about.brand.mark', { size: 64 })}
      <h2>{t('product')}</h2><span className={css.productName}>gs-worker</span>
      <p className={css.tagline}>{t('tagline')}</p>
    </header>
    <p className={css.description}>{t('description')}</p>
    <dl className={css.details}>
      <div><dt>{t('version')}</dt><dd>{version ?? t('versionUnavailable')}</dd></div>
      <div><dt>{t('capabilities')}</dt><dd>{t('capabilitiesDetail')}</dd></div>
      <div><dt>{t('accountService')}</dt><dd>{t('accountServiceDetail')}</dd></div>
    </dl>
  </section>
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gs account dictionary')
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher', priority: -10, locale: NS,
  }, AccountLauncher))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'gs-about', order: 130, label: () => ctx.locale.bind(NS)('about'), locale: NS,
    children: { 'gs.about.brand.mark': { kind: 'single', scope: 'root' } },
  }, AboutSection))
}
