/** Product Skills page: effective catalog and server-gated local creation. */
import { useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Skills.module.css'
import { NS, zh, en } from './locale.ts'

interface SkillRow {
  readonly name: string
  readonly description: string
  readonly source: string
  readonly userInvocable: boolean
  readonly modelInvocable: boolean
  readonly enabled?: boolean
  readonly available?: boolean
  readonly unavailableReason?: string
  readonly policy?: 'trusted-only'
}
interface SkillsView { readonly status: 'ok' | 'signed-out'; readonly skills: readonly SkillRow[] }
interface LocalInfo { readonly allowCreate: boolean; readonly managedRoot: string }
interface SkillsInject {
  readonly readSkills: () => Promise<SkillsView>
  readonly readLocalInfo: () => Promise<LocalInfo>
  readonly createLocalSkill: (name: string, description: string) => Promise<void>
  readonly setEnabled: (name: string, enabled: boolean) => Promise<void>
}

async function jsonRequest(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', redirect: 'error', cache: 'no-store' })
  if (!response.ok) throw new Error(`${path}: ${response.status}`)
  const value: unknown = await response.json()
  return value
}

async function readSkills(): Promise<SkillsView> {
  const value = await jsonRequest('api/gs-server/skills', { method: 'GET' })
  if (typeof value !== 'object' || value === null || !('status' in value) || !('skills' in value)
    || !Array.isArray(value.skills)) throw new Error('invalid skills response')
  return value as SkillsView
}

async function readLocalInfo(): Promise<LocalInfo> {
  const value = await jsonRequest('api/gs-server/local-skills', { method: 'GET' })
  if (typeof value !== 'object' || value === null || !('managedRoot' in value)
    || typeof value.managedRoot !== 'string' || !('allowCreate' in value)
    || typeof value.allowCreate !== 'boolean') throw new Error('invalid local skills response')
  return value as LocalInfo
}

async function createLocalSkill(name: string, description: string): Promise<void> {
  await jsonRequest('api/gs-server/local-skills', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  })
}

async function setEnabled(name: string, enabled: boolean): Promise<void> {
  await jsonRequest('api/gs-server/skills', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, enabled }),
  })
}

type SkillsProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS> & InjectFace<SkillsInject>

function SkillsSection({ t, readSkills: load, readLocalInfo: localInfo, createLocalSkill: create, setEnabled: saveEnabled }: SkillsProps) {
  const [view, setView] = useState<SkillsView>()
  const [local, setLocal] = useState<LocalInfo>()
  const [failed, setFailed] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [createFailed, setCreateFailed] = useState(false)
  const [toggleFailed, setToggleFailed] = useState(false)
  const [saving, setSaving] = useState<string>()
  const refresh = () => {
    setFailed(false)
    void Promise.all([load(), localInfo()]).then(([skills, info]) => {
      setView(skills)
      setLocal(info)
    }).catch(() => { setFailed(true) })
  }
  useEffect(() => { refresh() }, [load, localInfo])
  const rows = view?.skills ?? []
  const canCreate = !failed && view?.status === 'ok' && local?.allowCreate === true
  return <section className={css.root}>
    <header className={css.header}>
      <h2>{t('title')}</h2>
      <p>{t('intro')}</p>
      <button type="button" onClick={refresh}>{t('refresh')}</button>
    </header>
    {failed && <p role="alert">{t('failed')}</p>}
    {!failed && view === undefined && <p>{t('loading')}</p>}
    {view?.status === 'signed-out' && <p>{t('signedOut')}</p>}
    {view?.status === 'ok' && rows.length === 0 && <p>{t('empty')}</p>}
    {rows.length > 0 && <ul className={css.list}>{rows.map(skill => <li key={skill.name} className={css.row}>
      <div className={css.name}><strong>{skill.name}</strong><span className={css.badge}>{skill.source === 'server' ? t('server') : skill.source === 'local' ? t('local') : t('other')}</span></div>
      <p>{skill.description}</p>
      {skill.source === 'server' && <label className={css.switch}>
        <input type="checkbox" checked={skill.enabled === true} disabled={saving === skill.name || skill.available === false}
          onChange={(event) => {
            const enabled = event.target.checked
            setSaving(skill.name)
            setToggleFailed(false)
            void saveEnabled(skill.name, enabled).then(() => { refresh() })
              .catch(() => { setToggleFailed(true) }).finally(() => { setSaving(undefined) })
          }} />
        {t('enabled')}
      </label>}
      {skill.policy === 'trusted-only' && <small>{t('trustedOnly')}</small>}
      {!skill.userInvocable && !skill.modelInvocable && <small>{
        skill.unavailableReason === 'trusted-session-required' ? t('trustedSessionRequired')
          : skill.unavailableReason === 'runtime-unsupported' ? t('runtimeUnsupported')
            : skill.enabled === false && skill.available !== false ? t('disabled') : t('unavailable')
      }</small>}
      {skill.userInvocable && !skill.modelInvocable && <small>{t('userOnly')}</small>}
    </li>)}</ul>}
    {toggleFailed && <p role="alert">{t('toggleFailed')}</p>}
    {local !== undefined && <div className={css.local}>
      <h3>{t('createTitle')}</h3>
      <p>{t('managedRoot')}: <code>{local.managedRoot}</code></p>
      <p id="gs-local-skill-permission">{view?.status === 'signed-out' ? t('createSignIn')
        : failed ? t('createPermissionUnavailable') : local.allowCreate ? t('createAllowed') : t('createForbidden')}</p>
      <form aria-describedby="gs-local-skill-permission" onSubmit={(event) => {
        event.preventDefault()
        if (!canCreate || creating || name.trim() === '' || description.trim() === '') return
        setCreating(true)
        setCreateFailed(false)
        void create(name.trim(), description.trim()).then(() => {
          setName('')
          setDescription('')
          refresh()
        }).catch(() => { setCreateFailed(true) }).finally(() => { setCreating(false) })
      }}>
        <label>{t('name')}<input disabled={!canCreate || creating} value={name} onChange={(event) => { setName(event.target.value) }} required /></label>
        <label>{t('description')}<input disabled={!canCreate || creating} value={description} onChange={(event) => { setDescription(event.target.value) }} required /></label>
        <button type="submit" disabled={!canCreate || creating}>{creating ? t('creating') : t('create')}</button>
      </form>
      {createFailed && <p role="alert">{t('createFailed')}</p>}
    </div>}
  </section>
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gs skills dictionary')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'gs-skills', order: 110,
    label: () => ctx.locale.bind(NS)('title'), locale: NS,
    inject: () => ({ readSkills, readLocalInfo, createLocalSkill, setEnabled }),
  }, SkillsSection))
}
