/** Legacy imports retain original bytes and can resume after interrupted publication. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cp, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, stat, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { GsHomeMigrationError, migrateGsHome } from '../src/gs-home-migration.ts'

const faults = vi.hoisted(() => ({
  afterCopy: undefined as (() => Promise<void>) | undefined,
  failLinkAt: 0,
  links: 0,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs,
    cp: async (...args: Parameters<typeof cp>) => { await fs.cp(...args); await faults.afterCopy?.() },
    link: async (...args: Parameters<typeof link>) => {
      if (++faults.links === faults.failLinkAt) throw Object.assign(new Error('interrupted publish'), { code: 'EIO' })
      await fs.link(...args)
    },
  }
})

let root: string
let legacy: string
let home: string
const execute = promisify(execFile)
const children: ReturnType<typeof execute>[] = []
async function put(base: string, name: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(join(base, name)), { recursive: true, mode: 0o700 })
  await writeFile(join(base, name), value, { mode: 0o600 })
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gs-home-import-'))
  legacy = join(root, '.dsh')
  home = join(root, '.gs-worker')
  faults.afterCopy = undefined
  faults.failLinkAt = 0
  faults.links = 0
  await put(legacy, 'profiles/gs-desktop/package.json', '{"dsh":{"profile":{"bundles":[]}}}\n')
})
afterEach(async () => {
  for (const pending of children) {
    if (pending.child.exitCode === null && pending.child.signalCode === null) pending.child.kill('SIGTERM')
  }
  await Promise.allSettled(children.splice(0))
  rmSync(root, { recursive: true, force: true })
})

it('copies every Session generation, attachments, workspace state, GS configuration, and sign-in state without changing the source', async () => {
  const files = {
    'sessions/project/session-parent/session.jsonl': '{"type":"session","version":0}\n',
    'sessions/project/session-parent/session.v4.jsonl.zstd': Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 9, 2]),
    'sessions/project/session-child/session.v4.jsonl': '{"parentSession":"session-parent"}\n',
    'storages/workspace.json': '{"workspaces":["project"]}\n',
    'storages/attachments/sha256/image.png': Buffer.from([1, 2, 3, 4]),
    'profiles/gs-desktop/cordis.patch.yml': '- id: settings\n  config: {}\n',
    'profiles/gs-desktop/gs-server/tokens.json': '{"sealedRefreshToken":"test-token"}\n',
    '.credentials.yaml': 'test-key: test-value\n',
    'gs-skills/catalog.json': '{}\n',
  }
  for (const [name, contents] of Object.entries(files)) await put(legacy, name, contents)
  await put(legacy, 'profiles/desktop/cordis.patch.yml', 'upstream-only\n')
  await put(legacy, 'sessions/project/session-parent/session.lock', 'owned\n')
  await put(legacy, 'profiles/gs-desktop/lock', '123\n')
  await expect(migrateGsHome(legacy, home)).resolves.toBe('imported')
  for (const name of Object.keys(files)) {
    expect(await readFile(join(home, name))).toEqual(await readFile(join(legacy, name)))
    expect(await readFile(join(legacy, name))).toEqual(Buffer.from(files[name as keyof typeof files]))
  }
  await expect(stat(join(home, 'profiles/desktop'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(home, 'sessions/project/session-parent/session.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(home, 'profiles/gs-desktop/lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(legacy, 'profiles/desktop/cordis.patch.yml'), 'utf8')).toBe('upstream-only\n')
  await writeFile(join(home, 'storages/workspace.json'), 'independent\n')
  expect(await readFile(join(legacy, 'storages/workspace.json'), 'utf8')).toBe(files['storages/workspace.json'])
})

it('imports history into an already initialized home while retaining new conversations and settings', async () => {
  await put(legacy, 'sessions/project/old/session.v4.jsonl', 'old-history\n')
  await put(legacy, 'profiles/gs-desktop/cordis.patch.yml', 'old-settings\n')
  await put(home, 'sessions/project/new/session.v4.jsonl', 'new-history\n')
  await put(home, 'profiles/gs-desktop/cordis.patch.yml', 'new-settings\n')
  await migrateGsHome(legacy, home)
  expect(await readFile(join(home, 'sessions/project/old/session.v4.jsonl'), 'utf8')).toBe('old-history\n')
  expect(await readFile(join(home, 'sessions/project/new/session.v4.jsonl'), 'utf8')).toBe('new-history\n')
  expect(await readFile(join(home, 'profiles/gs-desktop/cordis.patch.yml'), 'utf8')).toBe('new-settings\n')
})

it('does not copy again after completion or import later writes made by the upstream client', async () => {
  await migrateGsHome(legacy, home)
  await put(legacy, 'sessions/project/later/session.v4.jsonl', 'later\n')
  await expect(migrateGsHome(legacy, home)).resolves.toBe('not-needed')
  await expect(stat(join(home, 'sessions/project/later'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('leaves a normal upstream-only installation and an explicit shared home alone', async () => {
  const upstream = join(root, 'upstream')
  await put(upstream, 'profiles/desktop/package.json', '{}\n')
  await expect(migrateGsHome(upstream, home)).resolves.toBe('not-needed')
  await expect(migrateGsHome(legacy, legacy)).resolves.toBe('not-needed')
  await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses a changing source before publishing any target files and removes its staging files', async () => {
  await put(legacy, 'sessions/project/old/session.v4.jsonl', 'before\n')
  let writes = 0
  faults.afterCopy = async () => {
    await put(legacy, 'sessions/project/old/session.v4.jsonl', `after-${++writes}\n`)
  }
  await expect(migrateGsHome(legacy, home)).rejects.toMatchObject({ reason: 'source-changed' })
  await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(root)).toEqual(['.dsh'])
})

it('retries a source that finishes saving while its first snapshot is being copied', async () => {
  await put(legacy, 'sessions/project/old/session.v4.jsonl', 'before\n')
  faults.afterCopy = async () => {
    faults.afterCopy = undefined
    await put(legacy, 'sessions/project/old/session.v4.jsonl', 'saved\n')
  }
  await expect(migrateGsHome(legacy, home)).resolves.toBe('imported')
  expect(await readFile(join(home, 'sessions/project/old/session.v4.jsonl'), 'utf8')).toBe('saved\n')
})

it('resumes an interrupted publication without replacing data the new client has since written', async () => {
  await put(legacy, '.credentials.yaml', 'old-credentials\n')
  await put(legacy, 'sessions/project/old/session.v4.jsonl', 'old-history\n')
  faults.failLinkAt = 2
  await expect(migrateGsHome(legacy, home)).rejects.toBeInstanceOf(GsHomeMigrationError)
  await expect(stat(join(home, '.gs-worker-import-v1'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(home, '.credentials.yaml'), 'utf8')).toBe('old-credentials\n')
  await put(home, '.credentials.yaml', 'new-credentials\n')
  faults.failLinkAt = 0
  await expect(migrateGsHome(legacy, home)).resolves.toBe('imported')
  expect(await readFile(join(home, '.credentials.yaml'), 'utf8')).toBe('new-credentials\n')
  expect(await readFile(join(home, 'sessions/project/old/session.v4.jsonl'), 'utf8')).toBe('old-history\n')
})

it('rejects a damaged completion marker instead of hiding missing history', async () => {
  await put(home, '.gs-worker-import-v1', '')
  await expect(migrateGsHome(legacy, home)).rejects.toBeInstanceOf(GsHomeMigrationError)
})

it('serializes competing imports and publishes only one completion marker', async () => {
  await put(legacy, 'sessions/project/old/session.v4.jsonl', 'history\n')
  const results = await Promise.all([migrateGsHome(legacy, home), migrateGsHome(legacy, home)])
  expect(results.sort()).toEqual(['imported', 'not-needed'])
  expect(await readFile(join(home, '.gs-worker-import-v1'), 'utf8')).toBe('complete\n')
})

it('coordinates independent upgrade processes using the same destination', async () => {
  const entry = pathToFileURL(resolve(import.meta.dirname, '../src/gs-home-migration.ts')).href
  const source = `import { migrateGsHome } from ${JSON.stringify(entry)}; console.log(await migrateGsHome(process.argv[1], process.argv[2]))`
  for (let count = 0; count < 2; count++) {
    children.push(execute(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', source, legacy, home], {
      env: { ...process.env, TSX_TSCONFIG_PATH: resolve('tsconfig.base.json') }, encoding: 'utf8',
    }))
  }
  const completed = await Promise.allSettled(children)
  expect(completed.every(result => result.status === 'fulfilled')).toBe(true)
  const results = completed.map((result) => {
    if (result.status === 'rejected') throw result.reason
    return result.value.stdout.toString().trim()
  })
  expect(results.sort()).toEqual(['imported', 'not-needed'])
})

it.skipIf(process.platform === 'win32')('retargets profile package links into the new home', async () => {
  const relativePlugin = 'profiles/gs-desktop/node_modules/plugin'
  const backing = 'profiles/gs-desktop/node_modules/.pnpm/plugin'
  await put(legacy, `${backing}/package.json`, '{}\n')
  await symlink(join(legacy, backing), join(legacy, relativePlugin))
  await migrateGsHome(legacy, home)
  expect(await readlink(join(home, relativePlugin))).toBe(join(home, backing))
  await writeFile(join(home, relativePlugin, 'package.json'), '{"new":true}\n')
  expect(await readFile(join(legacy, relativePlugin, 'package.json'), 'utf8')).toBe('{}\n')
})

it.skipIf(process.platform === 'win32')('does not follow linked data into another home', async () => {
  const outside = join(root, 'outside')
  await put(outside, 'history', 'outside\n')
  await symlink(outside, join(legacy, 'sessions'))
  await expect(migrateGsHome(legacy, home)).rejects.toBeInstanceOf(GsHomeMigrationError)
  expect(await readFile(join(outside, 'history'), 'utf8')).toBe('outside\n')
  expect((await lstat(join(legacy, 'sessions'))).isSymbolicLink()).toBe(true)
})
