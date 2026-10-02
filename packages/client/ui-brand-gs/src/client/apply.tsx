/** gs-worker brand occupants backed by the Host's cached cloud brand. */
import { useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { DESKTOP_BRAND_LOGO_DATA_URI } from './brand-logo.ts'

const NS = 'gs.brand'
const zh = { name: '办公 Agent', headline: '探索未至之境' } as const
const en: Record<keyof typeof zh, string> = { name: 'gs-worker', headline: 'Explore what is next' }
type Key = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'gs.brand': Key
  }
}

interface Brand { readonly name: string; readonly headline: string }
interface BrandInject { readonly readBrand: () => Promise<Brand> }

/** Parse only the two bounded text fields the renderer needs. */
function parseBrand(value: unknown): Brand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid brand response')
  const { name, headline } = value as Record<string, unknown>
  if (typeof name !== 'string' || name.length < 1 || name.length > 64
    || typeof headline !== 'string' || headline.length < 1 || headline.length > 128) {
    throw new Error('invalid brand response')
  }
  return { name, headline }
}

async function readBrand(): Promise<Brand> {
  const response = await fetch('api/gs-server/brand', {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`brand request failed (${response.status})`)
  const value: unknown = await response.json()
  return parseBrand(value)
}

function useBrand(read: BrandInject['readBrand']): Brand | undefined {
  const [brand, setBrand] = useState<Brand>()
  useEffect(() => {
    let active = true
    void read().then((value) => { if (active) setBrand(value) }).catch(() => {})
    return () => { active = false }
  }, [read])
  return brand
}

function BrandMark({ size, className }: { readonly size: number; readonly className?: string | undefined }) {
  return <img src={DESKTOP_BRAND_LOGO_DATA_URI} width={size} height={size} className={className} alt="" />
}

type NameProps = PropsRuntime<'sidebar.brand.name'> & PropsLocale<typeof NS> & InjectFace<BrandInject>
function BrandName({ t, readBrand: read }: NameProps) {
  const brand = useBrand(read)
  return <span>{brand?.name ?? t('name')}</span>
}

type HeadlineProps = PropsRuntime<'conversation.hero.brand.headline'> & PropsLocale<typeof NS> & InjectFace<BrandInject>
function BrandHeadline({ t, readBrand: read }: HeadlineProps) {
  const brand = useBrand(read)
  return <>{brand?.headline ?? t('headline')}</>
}

export const inject = ['slots', 'locale']

/** Fill all four product brand seats; the generic shells retain their layout. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('gs.about.brand.mark', () => ctx.slots.register({
    name: 'gs.about.brand.mark',
  }, BrandMark))
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'gs brand dictionary')
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
    name: 'sidebar.brand.mark',
  }, BrandMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name', locale: NS, inject: () => ({ readBrand }),
  }, BrandName))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
  }, BrandMark))
  ctx.slots.inject('conversation.hero.brand.headline', () => ctx.slots.register({
    name: 'conversation.hero.brand.headline', locale: NS, inject: () => ({ readBrand }),
  }, BrandHeadline))
}
