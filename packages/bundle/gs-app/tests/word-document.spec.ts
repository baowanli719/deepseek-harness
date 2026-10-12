/** Word creation on writable filesystems that reject hard links. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Projections from '@deepseek-ai/dsh-session-projection'
import Sandbox from '@deepseek-ai/dsh-sandbox-policy'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { strFromU8, unzipSync } from 'fflate'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as Word from '../src/word-document.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, link: vi.fn(async () => {
    throw Object.assign(new Error('Hard links are unsupported'), { code: 'ENOTSUP' })
  }) }
})

it('creates a valid DOCX without hard-link support and retains an existing destination', async () => {
  const home = await mkdtemp(join(tmpdir(), 'word-no-hardlinks-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  await ctx.plugin(Prompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Projections)
  await ctx.plugin(Sandbox, { mode: 'workspace-write', workspaceRoot: home })
  await ctx.plugin(Word)
  let counter = 0
  const create = (file_path: string) => ctx.tools.execute({ name: 'create_word_document',
    arguments: { file_path, title: '兼容文件系统', paragraphs: ['生成成功'] },
    callId: ToolCallId(`word-no-hardlinks-${++counter}`), signal: new AbortController().signal })
  expect((await create('报告.docx')).isError).toBeFalsy()
  const parts = unzipSync(await readFile(join(home, '报告.docx')))
  expect(strFromU8(parts['word/document.xml']!)).toContain('生成成功')
  const existing = join(home, '已有.docx')
  await writeFile(existing, 'existing document bytes')
  expect((await create(existing)).isError).toBe(true)
  expect(await readFile(existing, 'utf8')).toBe('existing document bytes')
  expect((await readdir(home)).filter(file => file.startsWith('.dsh-word-'))).toEqual([])
})
