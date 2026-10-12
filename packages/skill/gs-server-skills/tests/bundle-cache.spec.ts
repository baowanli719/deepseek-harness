import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  SkillBundleCache,
  safeSkillRelativePath,
  type SkillBundleFile,
} from '../src/bundle-cache.ts'
import {
  GsSkillExecutionClient,
  GsSkillRequestError,
  MAX_SKILL_FILES_RESPONSE_BYTES,
  parseSkillFilesResponse,
} from '../src/execution.ts'

const roots: string[] = []

function temporaryCacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gs-skill-bundle-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function textFile(path: string, text: string): SkillBundleFile {
  return { path, base64: Buffer.from(text, 'utf8').toString('base64') }
}

const RAW_SKILL = '---\nname: code-review\n---\n# Review carefully\n'

function bundleFiles(extra: readonly SkillBundleFile[] = []): SkillBundleFile[] {
  return [textFile('SKILL.md', RAW_SKILL), ...extra]
}

describe('safeSkillRelativePath', () => {
  it('accepts ordinary relative paths', () => {
    expect(safeSkillRelativePath('SKILL.md')).toEqual(['SKILL.md'])
    expect(safeSkillRelativePath('scripts/run.sh')).toEqual(['scripts', 'run.sh'])
  })

  it('rejects escapes and non-portable shapes', () => {
    for (const path of [
      '../evil',
      'a/../../evil',
      '/absolute',
      'C:\\windows',
      'c:/windows',
      'back\\slash',
      'a//b',
      'a/./b',
      './a',
      '',
      'nul\0',
      'x'.repeat(1025),
    ]) {
      expect(safeSkillRelativePath(path)).toBeUndefined()
    }
    expect(safeSkillRelativePath(42)).toBeUndefined()
  })
})

describe('SkillBundleCache.materialize', () => {
  it('separates account caches and refuses signed-out access', async () => {
    let account: string | undefined = 'alice'
    const cache = new SkillBundleCache(temporaryCacheRoot(), () => account)
    const first = await cache.materialize('code-review', '1.0.0', bundleFiles())
    account = 'bob'
    expect(await cache.readCached('code-review', '1.0.0')).toBeUndefined()
    const second = await cache.materialize('code-review', '1.0.0', [textFile('SKILL.md', 'Bob body')])
    expect(second.path).not.toBe(first.path)
    account = 'alice'
    expect((await cache.readCached('code-review', '1.0.0'))?.body).toContain('Review carefully')
    account = undefined
    expect(await cache.readCached('code-review', '1.0.0')).toBeUndefined()
    await expect(cache.materialize('code-review', '1.0.0', bundleFiles())).rejects.toThrow('signed out')
  })
  it('extracts the bundle into a versioned directory and strips frontmatter from the body', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)

    const bundle = await cache.materialize('code-review', '1.0.0', bundleFiles([
      textFile('scripts/check.sh', '#!/bin/sh\n'),
    ]))

    expect(bundle.path).toBe(join(root, 'code-review@1.0.0'))
    expect(bundle.body).toBe('# Review carefully\n')
    // The on-disk entry keeps its raw content; only the returned body is stripped.
    expect(readFileSync(join(bundle.path, 'SKILL.md'), 'utf8')).toBe(RAW_SKILL)
    expect(readFileSync(join(bundle.path, 'scripts', 'check.sh'), 'utf8')).toBe('#!/bin/sh\n')
    expect(readFileSync(join(bundle.path, '.complete'), 'utf8')).toBe('')
    expect(readdirSync(root)).toEqual(['code-review@1.0.0'])
  })

  it('strips a CRLF frontmatter block and leaves non-frontmatter content alone', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)

    const crlf = await cache.materialize('code-review', '1.0.0', [
      textFile('SKILL.md', '---\r\nname: code-review\r\n---\r\n# Body\r\n'),
    ])
    expect(crlf.body).toBe('# Body\r\n')

    const plain = await cache.materialize('code-review', '1.0.0', [
      textFile('SKILL.md', '# Body\n---\nnot frontmatter\n'),
    ])
    expect(plain.body).toBe('# Body\n---\nnot frontmatter\n')
  })

  it('creates a missing cache root on the first materialize', async () => {
    const parent = temporaryCacheRoot()
    const root = join(parent, 'missing-root')
    const cache = new SkillBundleCache(root)

    const bundle = await cache.materialize('code-review', '1.0.0', bundleFiles())

    expect(bundle.path).toBe(join(root, 'code-review@1.0.0'))
    expect(readdirSync(root)).toEqual(['code-review@1.0.0'])
  })

  it('removes superseded versions and leaves staging leftovers and other skills alone', async () => {
    const root = temporaryCacheRoot()
    mkdirSync(join(root, 'other-skill@1.0.0'))
    mkdirSync(join(root, 'code-review@9.9.tmp-1'))
    const cache = new SkillBundleCache(root)

    await cache.materialize('code-review', '1.0.0', bundleFiles())
    await cache.materialize('code-review', '2.0.0', bundleFiles())

    expect(readdirSync(root).sort()).toEqual(['code-review@2.0.0', 'code-review@9.9.tmp-1', 'other-skill@1.0.0'])
    await expect(cache.readCached('code-review', '1.0.0')).resolves.toBeUndefined()
    // Re-materializing the live version replaces it in place.
    await cache.materialize('code-review', '2.0.0', bundleFiles())
    expect(readdirSync(root).sort()).toEqual(['code-review@2.0.0', 'code-review@9.9.tmp-1', 'other-skill@1.0.0'])
  })

  it('refuses unsafe names and versions without writing anything', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)

    await expect(cache.materialize('../evil', '1.0.0', bundleFiles())).rejects.toThrow('unsafe name or version')
    await expect(cache.materialize('code-review', '../1.0', bundleFiles())).rejects.toThrow('unsafe name or version')
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses an empty bundle and one over the file count cap', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)

    await expect(cache.materialize('code-review', '1.0.0', [])).rejects.toThrow('file count')
    const tooMany = bundleFiles(Array.from({ length: MAX_SKILL_FILES }, (_, index) => textFile(`f${String(index)}.txt`, 'x')))
    await expect(cache.materialize('code-review', '1.0.0', tooMany)).rejects.toThrow('file count')
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses path escapes without writing anything', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)

    await expect(cache.materialize('code-review', '1.0.0', bundleFiles([
      textFile('../evil.md', 'escape'),
    ]))).rejects.toThrow('unsafe path')
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses files with malformed base64 characters or padding', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)

    for (const bad of ['QUJDRA==!', 'QUJD=AAA', 'QUJD====', 'QU JD', 'QUJ$']) {
      await expect(cache.materialize('code-review', '1.0.0', bundleFiles([
        { path: 'blob.bin', base64: bad },
      ]))).rejects.toThrow('invalid base64')
    }
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses bundles over the per-file and total byte caps', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)

    const tooBig = bundleFiles([{ path: 'blob.bin', base64: Buffer.alloc(MAX_SKILL_FILE_BYTES + 1).toString('base64') }])
    await expect(cache.materialize('code-review', '1.0.0', tooBig)).rejects.toThrow('exceeds')

    // Each file stays under the per-file cap; only the decoded total overflows.
    const chunk = Buffer.alloc(MAX_SKILL_FILE_BYTES).toString('base64')
    const tooLargeTotal = bundleFiles([0, 1, 2, 3].map(index => ({ path: `blob-${String(index)}.bin`, base64: chunk })))
    await expect(cache.materialize('code-review', '1.0.0', tooLargeTotal)).rejects.toThrow('exceeds')
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses a bundle without an entry document and never caches it', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)

    await expect(cache.materialize('code-review', '1.0.0', [textFile('README.md', 'no entry')]))
      .rejects.toThrow('missing SKILL.md')
    expect(readdirSync(root)).toEqual([])
  })

  it('materializes multi-megabyte files without overflowing the base64 check', async () => {
    // ~4.5 MB decoded: the strict base64 check must not overflow the regex
    // stack on this size, and the result stays under the per-file cap.
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)

    const bundle = await cache.materialize('code-review', '1.0.0', bundleFiles([
      { path: 'scripts/index.js', base64: Buffer.alloc(Math.floor(4.5 * 1024 * 1024), 65).toString('base64') },
    ]))

    expect(bundle.path).toBe(join(root, 'code-review@1.0.0'))
    expect(readdirSync(root)).toEqual(['code-review@1.0.0'])
  })

  it('cleans the staging directory and rethrows when a write fails mid-extraction', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)

    // `a` lands as a file, so `a/b` cannot create its parent directory.
    await expect(cache.materialize('code-review', '1.0.0', bundleFiles([
      textFile('a', 'file'),
      textFile('a/b', 'blocked'),
    ]))).rejects.toThrow()
    expect(readdirSync(root)).toEqual([])
  })
})

describe('SkillBundleCache.readCached', () => {
  it('serves a fully materialized directory with the frontmatter stripped', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)
    await cache.materialize('code-review', '1.0.0', bundleFiles())

    const cached = await cache.readCached('code-review', '1.0.0')

    expect(cached).toEqual({ path: join(root, 'code-review@1.0.0'), body: '# Review carefully\n' })
  })

  it('requires both the entry document and the completion marker', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)
    const directory = join(root, 'code-review@1.0.0')

    await expect(cache.readCached('code-review', '1.0.0')).resolves.toBeUndefined()

    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'SKILL.md'), RAW_SKILL, 'utf8')
    await expect(cache.readCached('code-review', '1.0.0')).resolves.toBeUndefined()

    writeFileSync(join(directory, '.complete'), '', 'utf8')
    rmSync(join(directory, 'SKILL.md'))
    await expect(cache.readCached('code-review', '1.0.0')).resolves.toBeUndefined()
  })

  it('refuses unsafe names and versions without touching the disk', async () => {
    const root = temporaryCacheRoot()
    const cache = new SkillBundleCache(root)

    await expect(cache.readCached('../evil', '1.0.0')).resolves.toBeUndefined()
    await expect(cache.readCached('code-review', '../1.0')).resolves.toBeUndefined()
  })
})

describe('parseSkillFilesResponse', () => {
  it('accepts the wire document', () => {
    expect(parseSkillFilesResponse({ name: 'code-review', files: [textFile('SKILL.md', RAW_SKILL)] }))
      .toEqual({ name: 'code-review', files: [textFile('SKILL.md', RAW_SKILL)] })
  })

  it('refuses malformed documents field by field', () => {
    const malformed: unknown[] = [
      42,
      null,
      [],
      { files: [] },
      { name: 'code-review', files: {} },
      { name: 'code-review', files: ['SKILL.md'] },
      { name: 'code-review', files: [null] },
      { name: 'code-review', files: [[]] },
      { name: 'code-review', files: [{ base64: 'eA==' }] },
      { name: 'code-review', files: [{ path: 'SKILL.md' }] },
    ]
    for (const value of malformed) {
      expect(() => parseSkillFilesResponse(value)).toThrow(GsSkillRequestError)
      expect(() => parseSkillFilesResponse(value)).toThrow('malformed files response')
    }
  })
})

describe('GsSkillExecutionClient.files', () => {
  interface RecordedCall {
    readonly path: string
    readonly init?: RequestInit
  }

  function clientWith(handler: (path: string) => Response): {
    readonly client: GsSkillExecutionClient
    readonly calls: RecordedCall[]
  } {
    const calls: RecordedCall[] = []
    const client = new GsSkillExecutionClient({
      fetch: (path, init) => {
        calls.push(init === undefined ? { path } : { path, init })
        return Promise.resolve(handler(path))
      },
      executeTimeoutMs: 1000,
    })
    return { client, calls }
  }

  it('fetches and validates the bundle document', async () => {
    const files = bundleFiles([textFile('scripts/check.sh', '#!/bin/sh\n')])
    const { client, calls } = clientWith(() => new Response(JSON.stringify({ name: 'code-review', files }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))

    const bundle = await client.files('code-review')

    expect(bundle).toEqual({ name: 'code-review', files })
    expect(calls.map(call => call.path)).toEqual(['/api/skills/code-review/files'])
    expect(calls[0]?.init?.method).toBe('GET')
  })

  it('reads bundle responses past the shared 1 MiB gateway cap', async () => {
    const big = Buffer.alloc(Math.floor(1.5 * 1024 * 1024), 66).toString('base64')
    const { client } = clientWith(() => new Response(
      JSON.stringify({ name: 'code-review', files: [textFile('SKILL.md', RAW_SKILL), { path: 'blob.bin', base64: big }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))

    const bundle = await client.files('code-review')

    expect(bundle.files).toHaveLength(2)
    expect(bundle.files[1]?.base64).toBe(big)
  })

  it('rejects responses over the bundle byte cap', async () => {
    const { client } = clientWith(() => new Response('x', {
      status: 200,
      headers: { 'content-length': String(MAX_SKILL_FILES_RESPONSE_BYTES + 1) },
    }))

    await expect(client.files('code-review')).rejects.toMatchObject({ code: 'response_too_large' })
  })

  it('rejects malformed wire documents and gateway failures', async () => {
    const malformed = clientWith(() => new Response(JSON.stringify({ name: 'code-review' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(malformed.client.files('code-review')).rejects.toMatchObject({ code: 'bad_response' })

    const failing = clientWith(() => new Response(JSON.stringify({ code: 'not_found', message: 'no such skill' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }))
    await expect(failing.client.files('code-review')).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })
})
