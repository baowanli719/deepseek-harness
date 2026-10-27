/** Copy legacy GS data into its independent home before the Desktop Host starts. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

const MARKER = '.gs-worker-import-v1'
const COMPLETE = 'complete\n'
const PROFILE = join('profiles', 'gs-desktop')
const DATA = ['sessions', 'storages', 'attachments', 'gs-skills', '.credentials.yaml', '.anonymous-user-id',
  'cordis.patch.yml', '.env', PROFILE]

/** A failed import leaves the old home unchanged and can be retried at startup. */
export class GsHomeMigrationError extends Error {
  /**
   * @param reason - A changing source needs a quiescent retry; other failures retain their filesystem cause.
   * @param cause - Original filesystem or verification failure.
   */
  constructor(readonly reason: 'source-changed' | 'io', cause?: unknown) {
    super(`GS data import failed (${reason})`, { cause })
  }
}

async function info(path: string) {
  try { return await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function included(path: string): boolean {
  const name = basename(path)
  return name !== 'lock' && !name.endsWith('.lock')
}

async function directory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const found = await lstat(path)
  if (!found.isDirectory() || found.isSymbolicLink()) throw new Error(`GS data import: expected a directory at ${path}`)
}

/** Include contents and directory membership so an active writer cannot silently change the import. */
async function fingerprint(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (path: string): Promise<void> => {
    if (!included(path)) return
    const found = await info(path)
    if (found === undefined) return
    const name = relative(root, path)
    hash.update(JSON.stringify([name, found.mode & 0o777]))
    if (found.isSymbolicLink()) {
      // User-installed linked plugins retain their explicit references; data directories must be independent.
      if (!name.startsWith(`${PROFILE}${sep}node_modules${sep}`)) {
        throw new Error(`GS data import: linked data is not supported at ${path}`)
      }
      hash.update(JSON.stringify(['link', await readlink(path)]))
    } else if (found.isDirectory()) {
      hash.update('directory')
      for (const child of (await readdir(path)).sort()) await visit(join(path, child))
    } else if (found.isFile()) {
      const contents = createHash('sha256')
      const bytes: AsyncIterable<Uint8Array> = createReadStream(path)
      for await (const chunk of bytes) contents.update(chunk)
      hash.update(contents.digest())
    } else {
      throw new Error(`GS data import: unsupported file at ${path}`)
    }
  }
  for (const name of DATA) await visit(join(root, name))
  return hash.digest('hex')
}

/** Retry snapshots observed to change; no imported files are published before verification succeeds. */
async function snapshot(legacyHome: string, staged: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const name of await readdir(staged)) await rm(join(staged, name), { recursive: true, force: true })
    try {
      const before = await fingerprint(legacyHome)
      for (const name of DATA) {
        const path = join(legacyHome, name)
        if (await info(path) === undefined) continue
        await cp(path, join(staged, name), { recursive: true, verbatimSymlinks: true, filter: included })
      }
      if (before === await fingerprint(staged) && before === await fingerprint(legacyHome)) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  throw new GsHomeMigrationError('source-changed')
}

/** Publish complete files exclusively; a retry never replaces files the new client already owns. */
async function merge(staged: string, target: string, legacyHome: string, home: string): Promise<void> {
  const source = await lstat(staged)
  if (source.isDirectory()) {
    await directory(target)
    for (const name of (await readdir(staged)).sort()) await merge(join(staged, name), join(target, name), legacyHome, home)
    return
  }
  try {
    if (source.isSymbolicLink()) {
      let destination = await readlink(staged)
      const suffix = relative(legacyHome, destination)
      if (isAbsolute(destination) && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)) {
        destination = join(home, suffix)
      }
      await symlink(destination, target, (await stat(staged)).isDirectory() ? 'junction' : 'file')
    } else await link(staged, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await lstat(target)
    if (source.isSymbolicLink() ? !existing.isSymbolicLink() : !existing.isFile() || existing.isSymbolicLink()) throw error
  }
}

/**
 * Import the legacy home once, copying bytes without decoding or rewriting Session generations.
 * @param legacyHome - Old shared home; import applies only when its GS profile exists.
 * @param home - Independent GS home, in an existing parent directory on the same filesystem as its staging files.
 * @returns Whether this call imported data; a completed import or absent legacy GS profile needs no work.
 * @throws {GsHomeMigrationError} on changed source data or filesystem failure. The Host must not start after failure.
 * Existing destination files win, source files are never modified, and an incomplete import resumes on restart.
 */
export async function migrateGsHome(legacyHome: string, home: string): Promise<'imported' | 'not-needed'> {
  if (legacyHome === home) return 'not-needed'
  try {
    return await withFileLock(`${home}.import`, async () => {
      const existingHome = await info(home)
      if (existingHome !== undefined && (!existingHome.isDirectory() || existingHome.isSymbolicLink())) {
        throw new Error(`GS data import: invalid destination at ${home}`)
      }
      const marker = join(home, MARKER)
      const completed = await info(marker)
      if (completed !== undefined) {
        if (!completed.isFile() || completed.isSymbolicLink() || await readFile(marker, 'utf8') !== COMPLETE) {
          throw new Error(`GS data import: invalid completion marker at ${marker}`)
        }
        return 'not-needed'
      }
      const profile = await info(join(legacyHome, PROFILE))
      if (profile === undefined) return 'not-needed'
      if (!profile.isDirectory() || profile.isSymbolicLink()) throw new Error('GS data import: invalid legacy GS profile')
      const staged = await mkdtemp(join(dirname(home), '.gs-worker-import-'))
      let failure: unknown
      try {
        await snapshot(legacyHome, staged)
        await directory(home)
        for (const name of await readdir(staged)) await merge(join(staged, name), join(home, name), legacyHome, home)
        const completedMarker = join(staged, MARKER)
        await writeFile(completedMarker, COMPLETE, { flag: 'wx', mode: 0o600 })
        await link(completedMarker, marker)
        return 'imported'
      } catch (error) {
        failure = error
        throw error
      } finally {
        try { await rm(staged, { recursive: true, force: true }) } catch (cleanup) {
          if (failure !== undefined) throw new AggregateError([failure, cleanup], 'GS data import cleanup failed')
          throw cleanup
        }
      }
    })
  } catch (error) {
    if (error instanceof GsHomeMigrationError) throw error
    throw new GsHomeMigrationError('io', error)
  }
}
