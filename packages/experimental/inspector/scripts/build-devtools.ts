/** Compile the fixed npm DevTools sources locally and publish the complete static frontend. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFrontend } from './devtools/vite.ts'
import { DEVTOOLS_NPM_VERSION, DEVTOOLS_SOURCE_REVISION } from './devtools/source.ts'

let pending: Promise<{ files: number; bytes: number }> | undefined

/**
 * Build lib/devtools without network access, retaining relative Worker and asset URLs.
 * @returns Published file count and bytes, excluding the distribution manifest.
 */
export function buildDevtools(): Promise<{ files: number; bytes: number }> {
  pending ??= compile().finally(() => { pending = undefined })
  return pending
}

async function compile(): Promise<{ files: number; bytes: number }> {
  const lib = fileURLToPath(new URL('../lib/', import.meta.url))
  await mkdir(lib, { recursive: true })
  const temporary = await mkdtemp(join(lib, 'devtools.build-'))
  try {
    await buildFrontend(temporary)
    const files: Array<{ path: string; bytes: number; sha256: string }> = []
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(join(temporary, directory), { withFileTypes: true })) {
        const path = directory ? `${directory}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(path)
        else {
          const bytes = await readFile(join(temporary, path))
          files.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
        }
      }
    }
    await walk('')
    const bytes = files.reduce((total, file) => total + file.bytes, 0)
    await writeFile(join(temporary, 'resource-manifest.json'), `${JSON.stringify({
      source: 'chrome-devtools-frontend', version: DEVTOOLS_NPM_VERSION, revision: DEVTOOLS_SOURCE_REVISION,
      builder: 'vite',
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    }, null, 2)}\n`)
    const output = join(lib, 'devtools')
    await rm(output, { recursive: true, force: true })
    await renameWithRetry(temporary, output)
    console.log(`DevTools npm ${DEVTOOLS_NPM_VERSION}: ${files.length} files, ${bytes} bytes`)
    return { files: files.length, bytes }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/**
 * Move the staged tree into place. Windows virus scanners and indexers briefly
 * hold freshly written files, so a transient EPERM/EBUSY on the rename retries
 * with backoff instead of failing the whole bundle.
 */
async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, target)
      return
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 4) throw cause
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildDevtools()
