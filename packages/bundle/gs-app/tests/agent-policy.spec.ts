/** Enterprise limits survive Loader composition, actual filesystem writes, and durable reload. */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

it('clamps local danger-full-access, applies live restrictions, and commits private events to disk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gs-agent-policy-'))
  let root: Context | undefined
  const reopened = new Context()
  onTestFinished(async () => {
    await root?.fiber.dispose()
    await reopened.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  let config: GsClientConfig | undefined = {
    version: 1, agent: { sandboxProfile: 'read-only', approvalPolicy: 'ask', dataClass: 'internal' },
    features: { customModel: false }, settingsPages: {}, permissions: { allowSubmit: false, allowExternalSkillInstall: false },
    skills: {}, models: null, appUpdate: null, notice: null,
  }
  class Remote extends GsServer {
    override async [Service.init](): Promise<void> {}
    override getClientConfig(): GsClientConfig | undefined { return config }
  }
  const file = join(home, 'cordis.yml')
  await writeFile(file, '[]\n')
  const builtins = { sessions: SessionStore, projections: Projections, persistence: Persistence, agents: AgentRegistry,
    loop: AgentLoop, llm: Llm, prompt: Prompt, tools: Tools, sandbox: Sandbox, approval: Approval,
    fs: Fs, files: ToolFs, server: Remote, private: Private, policy: Policy }
  const rows = Object.keys(builtins).map(id => ({ id, name: `cordis:${id}`, config:
    id === 'persistence' ? { root: join(home, 'history'), compression: 'none' }
      : id === 'sandbox' ? { mode: 'danger-full-access', workspaceRoot: home }
        : id === 'fs' ? { cwd: home } : id === 'server' ? { stateDir: join(home, 'auth'), clientVersion: 'test' }
          : id === 'loop' ? { agents: [] } : undefined }))
  const ctx = await boot('test', file, [{ insert: rows }], (ctx) => {
    root = ctx
    Object.assign(ctx.loader.builtins, builtins)
  })
  const id = SessionId('enterprise-policy')
  const agent = await ctx.agentLoop.create(id, { provider: 'test', model: 'test' }, { cwd: home })
  let counter = 0
  const write = () => ctx.tools.execute({ name: 'write', arguments: { file_path: 'result.txt', content: 'allowed' },
    callId: ToolCallId(`policy-${++counter}`), agent, signal: new AbortController().signal })
  expect((await write()).isError).toBe(true)
  expect(existsSync(join(home, 'result.txt'))).toBe(false)
  expect(ctx.sandboxPolicy.resolve({ session: agent.session, mode: 'danger-full-access' }).mode).toBe('read-only')
  config = { ...config, agent: { sandboxProfile: 'workspace-write', approvalPolicy: 'ask', dataClass: 'internal' } }
  ctx.emit('gs-server/client-config-changed', config)
  expect((await write()).isError).toBe(false)
  expect(await readFile(join(home, 'result.txt'), 'utf8')).toBe('allowed')
  config = { ...config, agent: { ...config.agent, approvalPolicy: 'plan', dataClass: 'confidential' } }
  ctx.emit('gs-server/client-config-changed', config)
  expect((await write()).isError).toBe(true)
  expect(ctx.sensitivePolicy.isPrivate(String(id))).toBe(true)
  await ctx.sessions.flush(agent.session)
  await ctx.fiber.dispose()
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
