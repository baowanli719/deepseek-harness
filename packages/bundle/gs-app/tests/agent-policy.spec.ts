/** Enterprise limits survive Loader composition, actual filesystem writes, and durable reload. */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { boot } from '@deepseek-ai/dsh-app-boot'
import GsServer, { type GsClientConfig } from '@deepseek-ai/dsh-gs-server'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm, { ToolCallId } from '@deepseek-ai/dsh-llm'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Sandbox from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import Fs from '@deepseek-ai/dsh-fs-sandbox'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as Private from '@deepseek-ai/dsh-sensitive-policy'
import * as Policy from '../src/agent-policy.ts'
import * as Word from '../src/word-document.ts'
import { strFromU8, unzipSync } from 'fflate'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'

it('clamps local danger-full-access, applies live restrictions, and commits private events to disk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gs-agent-policy-'))
  let root: Context | undefined
  const reopened = new Context()
  onTestFinished(async () => {
    await root?.fiber.dispose()
    await reopened.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  let config: GsClientConfig | undefined
  class Remote extends GsServer {
    override async [Service.init](): Promise<void> {}
    override getClientConfig(): GsClientConfig | undefined { return config }
  }
  const file = join(home, 'cordis.yml')
  await writeFile(file, '[]\n')
  const builtins = { sessions: SessionStore, projections: Projections, persistence: Persistence, agents: AgentRegistry,
    loop: AgentLoop, llm: Llm, prompt: Prompt, tools: Tools, sandbox: Sandbox, approval: Approval,
    fs: Fs, files: ToolFs, server: Remote, private: Private, policy: Policy, word: Word }
  const rows = Object.keys(builtins).map(id => ({ id, name: `cordis:${id}`, config:
    id === 'persistence' ? { root: join(home, 'history'), compression: 'none' }
      : id === 'sandbox' ? { mode: 'danger-full-access', workspaceRoot: home }
        : id === 'fs' ? { cwd: home } : id === 'server' ? { stateDir: join(home, 'auth'), clientVersion: 'test' }
          : id === 'loop' ? { agents: [] }
            : id === 'policy' ? { privateFullAccess: true }
              : id === 'private' ? { egressTools: [], restrictExternalMcp: false } : undefined }))
  const ctx = await boot('test', file, [{ insert: rows }], (ctx) => {
    root = ctx
    Object.assign(ctx.loader.builtins, builtins)
  })
  const id = SessionId('enterprise-policy')
  const agent = await ctx.agentLoop.create(id, { provider: 'test', model: 'test' }, { cwd: home })
  let counter = 0
  const write = () => ctx.tools.execute({ name: 'write', arguments: { file_path: 'result.txt', content: 'allowed' },
    callId: ToolCallId(`policy-${++counter}`), agent, signal: new AbortController().signal })
  // Unauthenticated: tools are denied, resolution stays read-only, and approvals never fire.
  expect((await write()).isError).toBe(true)
  expect(ctx.sandboxPolicy.resolve({ session: agent.session, mode: 'danger-full-access' }).mode).toBe('read-only')
  ctx.approval.setPolicy(agent, 'never')
  config = {
    version: 1, agent: { sandboxProfile: 'read-only', approvalPolicy: 'ask', dataClass: 'internal' },
    features: { customModel: false }, settingsPages: {}, permissions: { allowSubmit: false, allowExternalSkillInstall: false },
    skills: {}, models: null, appUpdate: null, notice: null,
  }
  ctx.emit('gs-server/client-config-changed', config)
  expect((await write()).isError).toBe(true)
  expect(existsSync(join(home, 'result.txt'))).toBe(false)
  expect(ctx.sandboxPolicy.resolve({ session: agent.session, mode: 'danger-full-access' }).mode).toBe('read-only')
  ctx.approval.setPolicy(agent, 'never')
  config = { ...config, agent: { sandboxProfile: 'workspace-write', approvalPolicy: 'ask', dataClass: 'internal' } }
  ctx.emit('gs-server/client-config-changed', config)
  ctx.approval.setPolicy(agent, 'ask')
  expect((await write()).isError).toBe(false)
  expect(await readFile(join(home, 'result.txt'), 'utf8')).toBe('allowed')
  ctx.sensitivePolicy.enterPrivate(String(id))
  expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('danger-full-access')
  ctx.approval.setPolicy(agent, 'ask')
  const word = (file_path = '报告.docx', tables = [[['指标', '结果'], ['本地生成', '成功']]]) => ctx.tools.execute({
    name: 'create_word_document', arguments: { file_path, title: '私密会话报告', paragraphs: ['中文正文 & <测试>\n第二行'], tables },
    callId: ToolCallId(`word-${++counter}`), agent, signal: new AbortController().signal,
  })
  const created = await word()
  expect(created.isError).toBeFalsy()
  expect(created.content.map(block => block.type === 'text' ? block.text.replace(home, '<workspace>').replaceAll('\\', '/') : block.type)).toMatchInlineSnapshot(`
    [
      "Created Word document: <workspace>/报告.docx",
    ]
  `)
  const original = await readFile(join(home, '报告.docx'))
  const parts = unzipSync(original)
  const xml = strFromU8(parts['word/document.xml']!)
  expect(xml).toContain('私密会话报告')
  expect(xml).toContain('中文正文 &amp; &lt;测试&gt;')
  expect(xml).toContain('<w:tbl>')
  expect(xml).toContain('<w:br/>')
  expect((await word()).isError).toBe(true)
  expect(await readFile(join(home, '报告.docx'))).toEqual(original)
  expect((await word('invalid.docx', [[['a'], ['b', 'c']]])).isError).toBe(true)
  expect((await word('output.html')).isError).toBe(true)
  const agentless = await ctx.tools.execute({ name: 'create_word_document',
    arguments: { file_path: 'agentless.docx', title: '无代理文档', paragraphs: ['无需表格'] },
    callId: ToolCallId(`word-${++counter}`), signal: new AbortController().signal })
  expect(agentless.isError).toBeFalsy()
  expect(ctx.tools.get('create_word_document')?.presentCall?.({ file_path: '报告.docx', title: 't', paragraphs: ['p'] }))
    .toEqual({ card: 'generic', title: 'Create Word: 报告.docx' })
  const outside = await mkdtemp(join(tmpdir(), 'word-outside-'))
  onTestFinished(() => rm(outside, { recursive: true, force: true }))
  await symlink(outside, join(home, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  setSandboxMode(agent.session, 'workspace-write')
  expect((await word(join('outside', 'escape.docx'))).isError).toBe(true)
  expect((await word(join(outside, 'escape.docx'))).isError).toBe(true)
  expect((await word(join('..', 'up.docx'))).isError).toBe(true)
  expect((await word('inside.docx')).isError).toBeFalsy()
  setSandboxMode(agent.session, 'danger-full-access')
  expect((await word(join(outside, 'external.docx'))).isError).toBeFalsy()
  const externalWrite = await ctx.tools.execute({ name: 'write',
    arguments: { file_path: join(outside, 'python-output.txt'), content: 'private full access' },
    callId: ToolCallId('private-external-write'), agent, signal: new AbortController().signal })
  expect(externalWrite.isError).toBe(false)
  expect(await readFile(join(outside, 'python-output.txt'), 'utf8')).toBe('private full access')
  expect((await readdir(outside)).sort()).toEqual(['external.docx', 'python-output.txt'])
  expect((await readdir(home)).filter(file => file.startsWith('.dsh-word-'))).toEqual([])
  config = { ...config, agent: { ...config.agent, sandboxProfile: 'read-only' } }
  ctx.emit('gs-server/client-config-changed', config)
  expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('danger-full-access')
  setSandboxMode(agent.session, 'read-only')
  expect((await word('read-only.docx')).isError).toBe(true)
  expect(existsSync(join(home, 'read-only.docx'))).toBe(false)
  config = { ...config, agent: { ...config.agent, approvalPolicy: 'plan', dataClass: 'confidential' } }
  ctx.emit('gs-server/client-config-changed', config)
  // Plan-only denial outranks the private full-access permission.
  expect(ctx.sandboxPolicy.resolve({ session: agent.session }).mode).toBe('read-only')
  ctx.approval.setPolicy(agent, 'never')
  expect((await write()).isError).toBe(true)
  expect((await word('read-only.docx')).isError).toBe(true)
  const confidential = await ctx.agentLoop.create(SessionId('confidential-second'), { provider: 'test', model: 'test' }, { cwd: home })
  expect(ctx.sensitivePolicy.isPrivate(String(confidential.session.id))).toBe(true)
  expect(ctx.sensitivePolicy.isPrivate(String(id))).toBe(true)
  await ctx.sessions.flush(agent.session)
  const tools = ctx.tools
  await ctx.fiber.dispose()
  expect(tools.get('create_word_document')).toBeUndefined()
  root = undefined
  await reopened.plugin(Persistence, { root: join(home, 'history'), compression: 'none' })
  const handle = await reopened.sessionPersistence.open(id, 'read')
  try {
    const events = (await handle.read()).events
    expect(events.filter(event => event.type === 'sensitive/policy')).toMatchObject([{ data: { kind: 'enter-private' } }])
    const core = new Private.SensitivePolicyCore()
    core.registerSession(String(id), Private.replaySensitivePolicyEvents(events.flatMap(event =>
      event.type === 'sensitive/policy' ? [event.data] : [])))
    expect(core.isPrivate(String(id))).toBe(true)
    expect(events.some(event => event.type === 'sensitive/policy')).toBe(true)
  } finally { await handle.close() }
})

it('tolerates a composition without the Agent registry on a confidential config change', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gs-agent-policy-no-agents-'))
  let root: Context | undefined
  onTestFinished(async () => {
    await root?.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  const config: GsClientConfig = {
    version: 1, agent: { sandboxProfile: 'workspace-write', approvalPolicy: 'ask', dataClass: 'internal' },
    features: { customModel: false }, settingsPages: {}, permissions: { allowSubmit: false, allowExternalSkillInstall: false },
    skills: {}, models: null, appUpdate: null, notice: null,
  }
  class Remote extends GsServer {
    override async [Service.init](): Promise<void> {}
    override getClientConfig(): GsClientConfig | undefined { return config }
  }
  const file = join(home, 'cordis.yml')
  await writeFile(file, '[]\n')
  const builtins = { projections: Projections, prompt: Prompt, tools: Tools, sandbox: Sandbox,
    approval: Approval, server: Remote, private: Private, policy: Policy }
  const rows = Object.keys(builtins).map(id => ({ id, name: `cordis:${id}`,
    config: id === 'sandbox' ? { mode: 'danger-full-access', workspaceRoot: home }
      : id === 'server' ? { stateDir: join(home, 'auth'), clientVersion: 'test' } : undefined }))
  const ctx = await boot('test', file, [{ insert: rows }], (ctx) => {
    root = ctx
    Object.assign(ctx.loader.builtins, builtins)
  })
  // The policy ceiling applies and every injected service loaded.
  expect(ctx.sandboxPolicy.resolve({}).mode).toBe('workspace-write')
  expect(ctx.get('agents')).toBeUndefined()
  await ctx.parallel('gs-server/client-config-changed', { ...config, agent: { ...config.agent, dataClass: 'confidential' } })
})
