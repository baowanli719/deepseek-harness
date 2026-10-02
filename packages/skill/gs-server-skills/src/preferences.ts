/** Account-scoped server skill switches, compatible with gs-worker's previous files. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { effectiveSkillModelPolicy, type GsSkillCatalogEntry, type GsServerRuntimeType } from './contract.ts'
import type { GsSkillExecutionClient } from './execution.ts'
import type { GsSkillConfigView } from './types.ts'
import { parseSkillExecutionSupport } from './server-skill-provider.ts'

/** One settings-page row of a delivered server skill. */
export interface ServerSkillPreferenceRow {
  readonly name: string
  readonly description: string
  readonly enabled: boolean
  readonly available: boolean
  readonly runtimeType: string
  readonly policy?: 'trusted-only'
  readonly unavailableReason?: 'runtime-unsupported' | 'trusted-session-required'
}

/** Inputs of the account-scoped server skill preference store. */
export interface ServerSkillPreferencesOptions {
  readonly root: string
  readonly accountKey: () => string | undefined
  readonly client: Pick<GsSkillExecutionClient, 'meta' | 'catalog'>
  readonly config: () => GsSkillConfigView | undefined
  readonly invalidate: () => void
}

/**
 * Account-scoped server skill switches, stored as one JSON file per skill
 * under the account hash so the previous gs-worker's files keep applying.
 */
export class ServerSkillPreferences {
  constructor(private readonly options: ServerSkillPreferencesOptions) {}

  private path(key: string, name: string): string {
    return join(this.options.root, createHash('sha256').update(key).digest('hex'), `${name}.json`)
  }

  /**
   * Effective switch of one delivered skill for the current account.
   * @param skill - catalog entry carrying the server default.
   * @param key - account key override; defaults to the current account.
   * @returns whether the skill is enabled; a missing or damaged preference
   *   falls back to the server default.
   */
  async enabledFor(skill: Pick<GsSkillCatalogEntry, 'name' | 'defaultEnabled'>, key: string | undefined = this.options.accountKey()): Promise<boolean> {
    if (key === undefined || !isSkillName(skill.name)) return false
    try {
      const value: unknown = JSON.parse(await readFile(this.path(key, skill.name), 'utf8'))
      if (typeof value === 'boolean') return value
    } catch { /* A missing or damaged preference falls back to the server default. */ }
    return skill.defaultEnabled !== false
  }

  /**
   * Settings-page rows of the current effective catalog; each row carries its
   * switch, availability, and the machine reason when unavailable.
   * @returns the rows, or an empty list while signed out or against a
   *   pre-capability server.
   */
  async list(): Promise<readonly ServerSkillPreferenceRow[]> {
    const key = this.options.accountKey()
    if (key === undefined) return []
    const [meta, catalog] = await Promise.all([this.options.client.meta(), this.options.client.catalog()])
    if (this.options.accountKey() !== key) return []
    const support = parseSkillExecutionSupport(meta)
    if (support === undefined) return []
    const controls = this.options.config()?.skills
    if (controls?.SKILLs === 'off') return []
    const rows = await Promise.all(catalog.skills.filter(skill => isSkillName(skill.name)
      && controls?.[skill.name] !== 'off').map(async (skill): Promise<ServerSkillPreferenceRow> => {
      const policy = effectiveSkillModelPolicy(support.policyVersion !== undefined, skill.modelPolicy)
      // `client` runtime skills load through the bundle cache, so only an
      // unrecognized server-executed type is runtime-unsupported here. A
      // trusted-only skill runs on the gated lane inside a private session;
      // this settings view is session-less, so it reports unavailable with
      // the trusted-session reason.
      const unavailableReason = skill.runtimeType !== 'client'
          && !support.types.includes(skill.runtimeType as GsServerRuntimeType)
        ? 'runtime-unsupported'
        : policy === 'trusted-only' ? 'trusted-session-required' : undefined
      return {
        name: skill.name,
        description: typeof skill.description === 'string' ? skill.description : '',
        runtimeType: skill.runtimeType,
        enabled: await this.enabledFor(skill, key),
        available: unavailableReason === undefined,
        ...(policy === 'trusted-only' ? { policy } : {}),
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
      }
    }))
    return this.options.accountKey() === key ? rows : []
  }

  /**
   * Persist one skill's switch for the current account; only a currently
   * delivered, available skill accepts a write.
   * @param name - exact skill name from the catalog.
   * @param enabled - the new switch.
   */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const key = this.options.accountKey()
    if (key === undefined || !isSkillName(name) || typeof enabled !== 'boolean') throw new Error('skill unavailable')
    const row = (await this.list()).find(skill => skill.name === name)
    if (this.options.accountKey() !== key || row === undefined || !row.available) throw new Error('skill unavailable')
    const path = this.path(key, name)
    await mkdir(dirname(path), { recursive: true })
    const staging = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(staging, JSON.stringify(enabled), 'utf8')
      if (this.options.accountKey() !== key) throw new Error('skill session changed')
      await rename(staging, path)
    } finally {
      await rm(staging, { force: true })
    }
    this.options.invalidate()
  }
}
