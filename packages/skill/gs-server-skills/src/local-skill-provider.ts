/**
 * Local skill provider for the gsclaw-server "allowed" lane, with
 * administrator-controlled trust gating.
 *
 * The provider scans two roots — an application-managed directory and the
 * user home `~/.skills` — and registers the parsed skills into the host
 * plane's `ctx.skills` registry with `source: 'local'`. Two independent
 * runtime gates stack on every list and load:
 *
 * - the server `permissions.allowLocalSkillCreate` ban: while active, every
 *   local candidate is listed non-invocable with
 *   `metadata.disabledByAdmin: true` and `get()` refuses to load it;
 * - admin-flagged restrictions (`ClientConfig.localSkillRestrictions`):
 *   a skill whose name AND current raw-content SHA-256 both match a
 *   restriction entry is gated `trusted-only` — non-invocable with
 *   `metadata.policy: 'trusted-only'` and `get()` refusing the body.
 *
 * Restrictions bind one content revision: an edit is a new revision whose
 * hash no longer matches, so the stale restriction stops applying until the
 * new content is re-flagged. Parsing mirrors `dsh-skill-filesystem`:
 * frontmatter requires `name` (isSkillName) and `description`, honors
 * `disable-model-invocation` / `user-invocable`, and invalid files
 * warn-and-skip without breaking discovery.
 *
 * @module dsh-gs-server-skills/local-skill-provider
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isSkillName,
  type SkillCandidate,
  type SkillDefinition,
  type SkillInvocationPolicy,
  type SkillLookupOptions,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill'
import { parse as parseYaml } from 'yaml'
import { normalizeLocalSkillRestrictions } from './contract.ts'
import { SERVER_SKILL_RANK } from './server-skill-provider.ts'
import type { GsServerBridge } from './types.ts'

/** Provider name in the `ctx.skills` registry. */
export const LOCAL_SKILL_PROVIDER_NAME = 'local-skill-provider'

/**
 * Rank above SERVER_SKILL_RANK: within a registry layer candidates sort by
 * rank ascending and the first wins a duplicate name, so server-delivered
 * skills always win same-name conflicts against local skills.
 */
export const LOCAL_SKILL_RANK = SERVER_SKILL_RANK + 100

/** Which of the two local roots produced one skill. */
export type LocalSkillRootKind = 'managed' | 'home'

/** View of one skill file the scanner skipped, with the refusal reason. */
export interface LocalSkillSkippedItem {
  /** Which root the skipped file lives under. */
  readonly root: LocalSkillRootKind
  /** File path relative to that root, e.g. `research_summary/SKILL.md`. */
  readonly path: string
  /** Machine-readable refusal reason from the parser or scanner. */
  readonly reason: string
}

/** Minimal logger face the provider needs; `ctx.logger` satisfies it. */
export interface LocalSkillLogger {
  warn(format: string, ...param: unknown[]): void
}

/** One scanned root; iteration order is the same-name precedence inside this provider. */
interface LocalSkillRoot {
  readonly path: string
  readonly root: LocalSkillRootKind
}

/** Opaque candidate locator handed back to `get()` for one local skill file. */
interface LocalSkillLocator {
  readonly path: string
  readonly directory: string
  readonly root: LocalSkillRootKind
}

/** Parse result of one local skill Markdown file. */
export interface ParsedLocalSkill {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationPolicy
  readonly metadata?: Record<string, unknown>
  readonly content: string
}

/** Options of the local skill provider. */
export interface LocalSkillProviderOptions {
  /** Application-managed root; scanned first and wins same-name conflicts. */
  readonly managedRoot: string
  /** User home root; scanned second. */
  readonly homeRoot: string
  /** Optional logger for skipped files and scan failures; discovery stays silent otherwise. */
  readonly logger?: LocalSkillLogger
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Locate the closing `---` of a YAML frontmatter block, mirroring upstream semantics. */
function splitFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined
  const contentStart = firstLineEnd + 1
  let lineStart = contentStart
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      const parsed: unknown = parseYaml(raw.slice(contentStart, lineStart))
      if (!isRecord(parsed)) return undefined
      return { data: parsed, body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1) }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/**
 * Parse one local skill Markdown file, mirroring `dsh-skill-filesystem`:
 * frontmatter must carry an isSkillName `name` and a non-empty `description`;
 * `disable-model-invocation` and `user-invocable: false` narrow invocation.
 * Returns a refusal reason instead of throwing so discovery can warn-and-skip.
 * @param raw - the raw file content.
 * @returns the parsed skill, or the refusal reason.
 */
export function parseLocalSkillMarkdown(raw: string): { parsed: ParsedLocalSkill } | { reason: string } {
  let frontmatter
  try {
    frontmatter = splitFrontmatter(raw)
  } catch (cause) {
    return { reason: `invalid YAML frontmatter: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
  if (frontmatter === undefined) return { reason: 'missing YAML frontmatter' }
  const nameValue = frontmatter.data.name
  const description = frontmatter.data.description
  if (typeof nameValue !== 'string' || nameValue === ''
    || typeof description !== 'string' || description === '') {
    return { reason: 'frontmatter requires name and description' }
  }
  if (!isSkillName(nameValue)) return { reason: `invalid skill name "${nameValue}"` }
  let invocation: SkillInvocationPolicy
  try {
    invocation = {
      modelInvocable: frontmatterBoolean(frontmatter.data, 'disable-model-invocation') !== true,
      userInvocable: frontmatterBoolean(frontmatter.data, 'user-invocable') !== false,
    }
  } catch (cause) {
    return { reason: `invalid invocation frontmatter: ${cause instanceof Error ? cause.message : String(cause)}` }
  }
  const whenToUse = frontmatter.data.whenToUse
  const metadata = frontmatter.data.metadata
  return {
    parsed: {
      name: nameValue,
      description,
      ...(typeof whenToUse === 'string' && whenToUse !== '' ? { whenToUse } : {}),
      invocation,
      ...(isRecord(metadata) ? { metadata } : {}),
      content: frontmatter.body.trim(),
    },
  }
}

/** One local skill found on disk before the runtime gates are applied. */
interface DiscoveredLocalSkill {
  readonly parsed: ParsedLocalSkill
  readonly locator: LocalSkillLocator
  /** SHA-256 of the raw file; the content revision restrictions key on. */
  readonly revision: string
}

/** Outcome of scanning one root: accepted skills plus skipped files with reasons. */
export interface LocalSkillRootScan {
  readonly skills: readonly DiscoveredLocalSkill[]
  readonly skipped: readonly LocalSkillSkippedItem[]
}

function isAbsentPathError(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** List one root's immediate entries; a missing root yields no skills. */
async function listRootEntries(path: string): Promise<readonly { name: string; directory: boolean }[]> {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' })
  } catch (cause) {
    if (isAbsentPathError(cause)) return []
    throw cause
  }
  const result: { name: string; directory: boolean }[] = []
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isFile()) {
      result.push({ name: entry.name, directory: entry.isDirectory() })
      continue
    }
    if (!entry.isSymbolicLink()) continue
    try {
      const info = await stat(join(path, entry.name))
      result.push({ name: entry.name, directory: info.isDirectory() })
    } catch {
      // A dangling symlink is not a skill.
    }
  }
  return result
}

/**
 * Scan one local root: immediate subdirectories carrying `SKILL.md` are
 * directory skills; flat `*.md` files are single-file skills. Invalid files
 * are collected as skipped entries with their refusal reason (and still
 * logged) instead of failing discovery silently.
 * @param root - the root to scan.
 * @param logger - optional logger for skipped files.
 * @returns accepted skills and skipped files.
 */
export async function discoverLocalSkillRoot(
  root: LocalSkillRoot,
  logger?: LocalSkillLogger,
): Promise<LocalSkillRootScan> {
  const skills: DiscoveredLocalSkill[] = []
  const skipped: LocalSkillSkippedItem[] = []
  const entries = [...await listRootEntries(root.path)].sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const locator: LocalSkillLocator | undefined = entry.directory
      ? { path: join(root.path, entry.name, 'SKILL.md'), directory: join(root.path, entry.name), root: root.root }
      : entry.name.endsWith('.md')
        ? { path: join(root.path, entry.name), directory: root.path, root: root.root }
        : undefined
    if (locator === undefined) continue
    const displayPath = entry.directory ? `${entry.name}/SKILL.md` : entry.name
    let raw: string
    try {
      raw = await readFile(locator.path, 'utf8')
    } catch (cause) {
      if (!isAbsentPathError(cause)) {
        const reason = `unreadable: ${String(cause)}`
        logger?.warn(`gs-server-skills: local skill file ${locator.path} ignored: ${reason}`)
        skipped.push({ root: root.root, path: displayPath, reason })
      }
      continue
    }
    const outcome = parseLocalSkillMarkdown(raw)
    if ('reason' in outcome) {
      logger?.warn(`gs-server-skills: local skill file ${locator.path} ignored: ${outcome.reason}`)
      skipped.push({ root: root.root, path: displayPath, reason: outcome.reason })
      continue
    }
    skills.push({ parsed: outcome.parsed, locator, revision: createHash('sha256').update(raw).digest('hex') })
  }
  return { skills, skipped }
}

/**
 * Local skill provider for the allowed lane of `allowLocalSkillCreate`. All
 * reads go through Node directly: both roots live outside any ctx.fs
 * workspace.
 */
export class LocalSkillProvider implements SkillProvider {
  readonly name = LOCAL_SKILL_PROVIDER_NAME

  constructor(
    private readonly bridge: GsServerBridge,
    private readonly options: LocalSkillProviderOptions,
  ) {}

  private roots(): readonly LocalSkillRoot[] {
    return [
      { path: this.options.managedRoot, root: 'managed' },
      { path: this.options.homeRoot, root: 'home' },
    ]
  }

  /** Whether the server currently permits local skill creation and use. */
  private allowLocalSkillCreate(): boolean {
    return this.bridge.getClientConfig()?.permissions?.allowLocalSkillCreate !== false
  }

  /**
   * Admin restriction of one skill's exact content revision: the live
   * ClientConfig restriction list decides — name and current content SHA-256
   * must both match. Restrictions bind a content revision: an edited file is
   * a new revision that no longer matches and reverts to the standard default
   * until re-flagged.
   */
  private restrictedTrustedOnly(skillName: string, revision: string): boolean {
    return normalizeLocalSkillRestrictions(this.bridge.getClientConfig()?.localSkillRestrictions)
      .some(entry => entry.name === skillName && entry.contentHash === revision)
  }

  /**
   * Scan both roots in precedence order; unreadable roots warn-and-skip and
   * surface as one skipped entry.
   */
  private async discoverAll(): Promise<LocalSkillRootScan> {
    const skills: DiscoveredLocalSkill[] = []
    const skipped: LocalSkillSkippedItem[] = []
    for (const root of this.roots()) {
      try {
        const scan = await discoverLocalSkillRoot(root, this.options.logger)
        skills.push(...scan.skills)
        skipped.push(...scan.skipped)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        this.options.logger?.warn(`gs-server-skills: local skill root ${root.path} ignored: ${reason}`)
        skipped.push({ root: root.root, path: '', reason: `root unreadable: ${reason}` })
      }
    }
    return { skills, skipped }
  }

  async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
    options.signal?.throwIfAborted()
    if (await this.bridge.getAccessToken() === undefined) return []
    const candidates: SkillCandidate[] = []
    const seen = new Set<string>()
    const scan = await this.discoverAll()
    if (await this.bridge.getAccessToken() === undefined) return []
    const allowLocalSkillCreate = this.allowLocalSkillCreate()
    for (const { parsed, locator, revision } of scan.skills) {
      options.signal?.throwIfAborted()
      // The managed root wins same-name conflicts against the home root.
      if (seen.has(parsed.name)) continue
      seen.add(parsed.name)
      // Two independent gates stack: the admin ban (allowLocalSkillCreate) and
      // the data-egress policy. Local skills default to standard; only an
      // admin restriction for this exact content revision (name + current
      // SHA-256) gates a skill as trusted-only, and both marks stay visible
      // in the metadata for audit consumers.
      const restricted = this.restrictedTrustedOnly(parsed.name, revision)
      const invocable = allowLocalSkillCreate && !restricted
      const invocation = invocable
        ? parsed.invocation
        : { modelInvocable: false, userInvocable: false }
      candidates.push({
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation,
        source: 'local',
        provider: LOCAL_SKILL_PROVIDER_NAME,
        rank: LOCAL_SKILL_RANK,
        locator,
        path: locator.path,
        resourceBase: { kind: 'directory', path: locator.directory },
        metadata: {
          ...(parsed.metadata ?? {}),
          root: locator.root,
          ...(allowLocalSkillCreate ? {} : { disabledByAdmin: true }),
          ...(restricted ? { policy: 'trusted-only' } : {}),
        },
      })
    }
    return candidates
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    // The load-side gate is the second fence: a banned or signed-out session
    // can never materialize a local skill body, even with a stale candidate.
    if (await this.bridge.getAccessToken() === undefined || !this.allowLocalSkillCreate()
      || !isSkillName(candidate.name)) return undefined
    const locator = candidate.locator as Partial<LocalSkillLocator> | undefined
    if (typeof locator?.path !== 'string' || typeof locator.directory !== 'string'
      || (locator.root !== 'managed' && locator.root !== 'home')) return undefined
    let raw: string
    try {
      raw = await readFile(locator.path, { encoding: 'utf8', signal: options.signal })
    } catch {
      return undefined
    }
    if (await this.bridge.getAccessToken() === undefined || !this.allowLocalSkillCreate()) return undefined
    // The policy fence: only restricted content (name + exact revision) is
    // refused; everything else loads as standard. The hash is recomputed from
    // the freshly read bytes, so a tampered file can never ride a stale
    // candidate's revision.
    if (this.restrictedTrustedOnly(candidate.name, createHash('sha256').update(raw).digest('hex'))) {
      return undefined
    }
    const outcome = parseLocalSkillMarkdown(raw)
    if ('reason' in outcome || outcome.parsed.name !== candidate.name) return undefined
    const parsed = outcome.parsed
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      invocation: parsed.invocation,
      source: 'local',
      provider: LOCAL_SKILL_PROVIDER_NAME,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
      ...(candidate.metadata === undefined ? {} : { metadata: candidate.metadata }),
      content: parsed.content,
    }
  }
}
