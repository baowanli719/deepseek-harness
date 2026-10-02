/**
 * Safe on-disk cache for client-runtime skill bundles delivered by
 * gsclaw-server (`GET /api/skills/:name/files`). Each bundle materializes
 * under `<root>/<name>@<version>`: extraction is staged beside the target and
 * the `.complete` marker is written last, so a crash or a refused bundle
 * never leaves a loadable partial directory; superseded versions of the same
 * skill are removed once the new one lands. The safety rules mirror the
 * server's extraction contract: relative forward-slashed paths without dot
 * segments, strict base64, per-file/total/count caps, and a required root
 * `SKILL.md`.
 *
 * @module dsh-gs-server-skills/bundle-cache
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isSkillName } from '@deepseek-ai/dsh-skill'

/** Decoded byte cap of one bundle file. */
export const MAX_SKILL_FILE_BYTES = 8 * 1024 * 1024
/** Decoded byte cap of the whole bundle. */
export const MAX_SKILL_TOTAL_BYTES = 30 * 1024 * 1024
/** File count cap of one bundle. */
export const MAX_SKILL_FILES = 500
/** Character cap of one bundle file path. */
export const MAX_SKILL_PATH_CHARS = 1024

/** Bundle entry document and the write-completion marker inside a cache directory. */
const SKILL_ENTRY_FILE = 'SKILL.md'
const SKILL_CACHE_MARKER = '.complete'

/** Version strings double as cache path segments, so keep them path-safe. */
const SAFE_SKILL_VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/u
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u

/** One file of the `GET /api/skills/:name/files` bundle. */
export interface SkillBundleFile {
  /** Bundle-relative path; validated by {@link safeSkillRelativePath}. */
  readonly path: string
  /** Strict base64 of the file content. */
  readonly base64: string
}

/** A fully materialized bundle ready to load. */
export interface MaterializedSkillBundle {
  /** Absolute cache directory `<root>/<name>@<version>`; resources resolve under it. */
  readonly path: string
  /** `SKILL.md` content with the frontmatter stripped. */
  readonly body: string
}

/**
 * Strict base64 without a regex: the character-class pattern overflows the
 * regex engine stack on multi-megabyte skill payloads.
 */
function isStrictBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false
  let padding = 0
  for (let i = value.length - 1; i >= 0 && value.charCodeAt(i) === 61; i -= 1) padding += 1
  if (padding > 2) return false
  const bodyEnd = value.length - padding
  for (let i = 0; i < bodyEnd; i++) {
    const code = value.charCodeAt(i)
    const ok = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47
    if (!ok) return false
  }
  return true
}

/**
 * Validate one server-supplied bundle path with gs-worker's
 * safe_relative_path semantics: relative, forward-slashed, and free of `.` /
 * `..` segments, so extraction can never escape the cache directory.
 * @param path - raw path of one bundle file.
 * @returns the path segments, or undefined when the path is unsafe.
 */
export function safeSkillRelativePath(path: unknown): string[] | undefined {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_SKILL_PATH_CHARS) return undefined
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/')) return undefined
  if (/^[A-Za-z]:/u.test(path)) return undefined
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  return segments
}

/** Strip the YAML frontmatter block a bundle entry may carry. */
function stripSkillFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, '')
}

/**
 * Versioned cache of server-delivered skill bundles. All reads and writes go
 * through Node directly: the cache root lives outside any ctx.fs workspace.
 */
export class SkillBundleCache {
  /**
   * @param root - cache root holding one `<name>@<version>` directory per
   * delivered bundle; created on the first materialize.
   */
  constructor(private readonly root: string, private readonly accountKey?: () => string | undefined) {}

  private scopedRoot(): string {
    if (this.accountKey === undefined) return this.root
    const account = this.accountKey()
    if (account === undefined) throw new Error('gs-server-skills: signed out of bundle cache')
    return join(this.root, createHash('sha256').update(account).digest('hex'))
  }

  /**
   * Validate and extract one bundle into `<root>/<name>@<version>`. A refused
   * bundle throws before anything is written; superseded versions of the same
   * skill are removed once the new directory lands.
   * @param name - exact skill name from the catalog.
   * @param version - delivered bundle version.
   * @param files - wire files of the bundle, validated field by field here.
   * @returns the materialized bundle.
   */
  async materialize(name: string, version: string, files: readonly SkillBundleFile[]): Promise<MaterializedSkillBundle> {
    const label = `${name}@${version}`
    const refuse = (reason: string): Error => new Error(`gs-server-skills: skill bundle refused for ${label}: ${reason}`)
    if (!isSkillName(name) || !SAFE_SKILL_VERSION.test(version)) throw refuse('unsafe name or version')
    if (files.length === 0 || files.length > MAX_SKILL_FILES) throw refuse('file count out of range')
    const decoded: { readonly segments: readonly string[]; readonly content: Buffer }[] = []
    let totalBytes = 0
    for (const file of files) {
      const segments = safeSkillRelativePath(file.path)
      if (segments === undefined) throw refuse(`unsafe path ${file.path}`)
      if (!isStrictBase64(file.base64)) throw refuse(`invalid base64 for ${file.path}`)
      const content = Buffer.from(file.base64, 'base64')
      if (content.byteLength > MAX_SKILL_FILE_BYTES) throw refuse(`file ${file.path} exceeds ${String(MAX_SKILL_FILE_BYTES)} bytes`)
      totalBytes += content.byteLength
      if (totalBytes > MAX_SKILL_TOTAL_BYTES) throw refuse(`bundle exceeds ${String(MAX_SKILL_TOTAL_BYTES)} bytes`)
      decoded.push({ segments, content })
    }
    // A bundle without an entry document is not loadable; refuse to cache it.
    const entry = decoded.find(file => file.segments.length === 1 && file.segments[0] === SKILL_ENTRY_FILE)
    if (entry === undefined) throw refuse(`missing ${SKILL_ENTRY_FILE}`)

    const root = this.scopedRoot()
    const directory = join(root, label)
    // Superseded versions are enumerated before staging exists; a missing root
    // on the first materialize is a plain empty sibling list.
    const siblings = await readdir(root).catch(() => [] as string[])
    await mkdir(root, { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(`${directory}.tmp-`)
    try {
      for (const file of decoded) {
        const target = join(staging, ...file.segments)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, file.content)
      }
      await writeFile(join(staging, SKILL_CACHE_MARKER), '')
      await rm(directory, { recursive: true, force: true })
      await rename(staging, directory)
    } catch (cause) {
      /* v8 ignore next -- the staging cleanup fails only on a filesystem fault concurrent with the write fault. */
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      throw cause
    }
    for (const sibling of siblings) {
      if (sibling.startsWith(`${name}@`) && !sibling.includes('.tmp-') && sibling !== label) {
        /* v8 ignore next -- a sibling removed concurrently is already gone. */
        await rm(join(root, sibling), { recursive: true, force: true }).catch(() => undefined)
      }
    }
    return { path: directory, body: stripSkillFrontmatter(entry.content.toString('utf8')) }
  }

  /**
   * Read a fully materialized cache directory, or undefined on any gap:
   * unsafe name or version, a missing entry document, or a missing
   * `.complete` marker (a partial extraction never passes).
   * @param name - exact skill name from the catalog.
   * @param version - delivered bundle version.
   * @returns the cached bundle, or undefined.
   */
  async readCached(name: string, version: string): Promise<MaterializedSkillBundle | undefined> {
    if (!isSkillName(name) || !SAFE_SKILL_VERSION.test(version)) return undefined
    let content: string
    let directory: string
    try {
      directory = join(this.scopedRoot(), `${name}@${version}`)
      content = await readFile(join(directory, SKILL_ENTRY_FILE), 'utf8')
      await readFile(join(directory, SKILL_CACHE_MARKER))
    } catch {
      return undefined
    }
    return { path: directory, body: stripSkillFrontmatter(content) }
  }
}
