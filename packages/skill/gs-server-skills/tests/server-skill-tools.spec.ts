import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SensitivePolicyCore } from '@deepseek-ai/dsh-sensitive-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { GsClientConfig } from '@deepseek-ai/dsh-gs-server'
import * as gsServerSkills from '../src/index.ts'

/** Minimal valid ClientConfig for the change event; the listener only needs the push. */
const CLIENT_CONFIG: GsClientConfig = {
  version: 1,
  agent: { sandboxProfile: 'workspace-write', approvalPolicy: 'ask', dataClass: 'internal' },
  features: { customModel: false },
  settingsPages: {},
  permissions: { allowSubmit: true, allowExternalSkillInstall: false },
  skills: {},
  models: { providers: {} },
  appUpdate: null,
  notice: null,
}
import type { GsSkillConfigView, GsServerBridge } from '../src/index.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-gs-server-skills-${name}-`))
  tempDirs.push(dir)
  return dir
}

/** One recorded bridge request. */
interface RecordedRequest {
  readonly path: string
  readonly init?: RequestInit | undefined
}

/** Mock `ctx.gsServer` bridge; only `fetch` routing is exercised. */
class MockBridge implements GsServerBridge {
  readonly requests: RecordedRequest[] = []
  clientConfig: GsSkillConfigView | undefined
  accessToken: string | undefined = 'test-token'
  constructor(public handler: (path: string, init?: RequestInit) => Response) {}
  getAccessToken(): Promise<string | undefined> {
    return Promise.resolve(this.accessToken)
  }
  fetch(path: string, init?: RequestInit): Promise<Response> {
    this.requests.push({ path, init })
    return Promise.resolve(this.handler(path, init))
  }
  getClientConfig(): GsSkillConfigView | undefined {
    return this.clientConfig
  }
  sessionView() {
    return this.accessToken === undefined
      ? { status: 'signed-out', endpoint: 'https://gs.example.test' }
      : { status: 'signed-in', endpoint: 'https://gs.example.test', user: { id: 7 } }
  }
  /** Count of recorded requests to one path. */
  count(path: string): number {
    return this.requests.filter(request => request.path === path).length
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

const META = {
  serviceName: 'gsclaw-server',
  serviceVersion: '1.0.0',
  loginMethods: [],
  minimumClientVersion: '0.0.0',
  llmProxy: false,
  skillExecution: { version: 1, types: ['data-query', 'server-mcp'], policyVersion: 1 },
}

const CATALOG = {
  skills: [
    {
      name: 'sales-query',
      displayName: 'Sales Query',
      description: 'Query the sales warehouse.',
      version: '1.0.0',
      runtimeType: 'data-query',
      definitionRevision: 'rev-1',
      modelPolicy: 'standard',
    },
    {
      name: 'docs-mcp',
      displayName: 'Docs MCP',
      description: 'Search the document store.',
      version: '2.0.0',
      runtimeType: 'server-mcp',
      definitionRevision: 'rev-9',
      modelPolicy: 'standard',
    },
  ],
}

/** Trusted-only server-mcp catalog entry retained for the gated lane. */
const ZHIDU_CATALOG_ENTRY = {
  name: 'zhidu-knowledge',
  displayName: 'Knowledge Base',
  description: 'Consult the policy knowledge base.',
  version: '3.0.0',
  runtimeType: 'server-mcp',
  definitionRevision: 'rev-z1',
  modelPolicy: 'trusted-only',
}

const ZHIDU_DEFINITION = {
  name: 'zhidu-knowledge',
  version: '3.0.0',
  runtimeType: 'server-mcp',
  definitionRevision: 'rev-z1',
  content: 'Consult the policy knowledge base.',
  mcp: { tools: [{ name: 'search-rules', description: 'Search rules.', inputSchema: { type: 'object' } }] },
  modelPolicy: 'trusted-only',
}

/** Minimal agent stand-in: the scope key and session identity the gated lane reads. */
function fakeAgent(sessionId: string): Agent {
  const id = SessionId(sessionId)
  return { id, session: { id, header: { id } } } as Agent
}

/** Handler routing the standard meta/catalog handshake and recording execute bodies. */
function standardHandler(overrides: {
  catalog?: unknown
  execute?: (skill: string) => Response
} = {}): (path: string, init?: RequestInit) => Response {
  return (path) => {
    if (path === '/api/v1/meta') return json(META)
    if (path === '/api/v1/skills/catalog') return json(overrides.catalog ?? CATALOG)
    if (path === '/api/v1/skills/zhidu-knowledge/definition') return json(ZHIDU_DEFINITION)
    const execute = /^\/api\/v1\/skills\/([^/]+)\/execute$/u.exec(path)
    if (execute !== null) {
      return overrides.execute?.(decodeURIComponent(execute[1] ?? '')) ?? json({
        requestId: 'req-1',
        traceId: 'trace-1',
        status: 'ok',
        content: [{ type: 'text', text: 'result rows' }],
        truncated: false,
      })
    }
    return json({ code: 'not_found', message: `no mock route for ${path}` }, 404)
  }
}

async function setup(handler: (path: string, init?: RequestInit) => Response): Promise<{ ctx: Context; bridge: MockBridge }> {
  const home = await tempDir('home')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SkillRegistry)
  const bridge = new MockBridge(handler)
  ctx.provide('gsServer', bridge)
  await ctx.plugin(gsServerSkills, {
    localSkillManagedRoot: join(home, 'managed'),
    localSkillHomeRoot: join(home, 'home'),
    preferenceRoot: join(home, 'preferences'),
  })
  return { ctx, bridge }
}

function executeCall(ctx: Context, name: string, args: Record<string, unknown>, agent?: Agent) {
  return ctx.tools.execute({
    callId: ToolCallId(`call-${String(Math.random())}`),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: new AbortController().signal,
  })
}

describe('server skill bridge tools', () => {
  it('registers no bridge tools before the first sync', async () => {
    const { ctx } = await setup(standardHandler())
    expect(ctx.tools.get(gsServerSkills.RUN_DATA_QUERY_TOOL)).toBeUndefined()
    expect(ctx.tools.get(gsServerSkills.RUN_MCP_SKILL_TOOL)).toBeUndefined()
  })

  it('registers both bridge tools with their model-facing schemas after a sync', async () => {
    const { ctx } = await setup(standardHandler())
    await ctx.skills.list({})
    const dataQuery = ctx.tools.get(gsServerSkills.RUN_DATA_QUERY_TOOL)
    const mcpSkill = ctx.tools.get(gsServerSkills.RUN_MCP_SKILL_TOOL)
    expect(dataQuery).toBeDefined()
    expect(mcpSkill).toBeDefined()
    const dataQueryParams = dataQuery?.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(dataQueryParams.properties).sort()).toEqual(['params', 'query', 'skill'])
    expect(dataQueryParams.required.sort()).toEqual(['query', 'skill'])
    const mcpParams = mcpSkill?.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(mcpParams.properties).sort()).toEqual(['arguments', 'skill', 'tool'])
    expect(mcpParams.required.sort()).toEqual(['skill', 'tool'])
  })

  it('forwards run_data_query to the execute endpoint and renders the text result', async () => {
    const { ctx, bridge } = await setup(standardHandler())
    await ctx.skills.list({})
    const result = await executeCall(ctx, gsServerSkills.RUN_DATA_QUERY_TOOL, {
      skill: 'sales-query',
      query: 'top-sales',
      params: { limit: 5 },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'result rows' }])
    const executeRequest = bridge.requests.find(request => request.path === '/api/v1/skills/sales-query/execute')
    expect(executeRequest?.init?.method).toBe('POST')
    const body = JSON.parse(typeof executeRequest?.init?.body === 'string' ? executeRequest.init.body : '') as Record<string, unknown>
    expect(typeof body.requestId).toBe('string')
    expect(body.definitionRevision).toBe('rev-1')
    expect(body.arguments).toEqual({ query: 'top-sales', params: { limit: 5 } })
    // A session-less execution carries neither the session id nor the audit header.
    expect(body.sessionId).toBeUndefined()
    expect(executeRequest?.init?.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('forwards run_mcp_skill with the tool name and arguments', async () => {
    const { ctx, bridge } = await setup(standardHandler())
    await ctx.skills.list({})
    const result = await executeCall(ctx, gsServerSkills.RUN_MCP_SKILL_TOOL, {
      skill: 'docs-mcp',
      tool: 'search-docs',
      arguments: { phrase: 'report' },
    })
    expect(result.isError).toBe(false)
    const executeRequest = bridge.requests.find(request => request.path === '/api/v1/skills/docs-mcp/execute')
    const body = JSON.parse(typeof executeRequest?.init?.body === 'string' ? executeRequest.init.body : '') as Record<string, unknown>
    expect(body.definitionRevision).toBe('rev-9')
    expect(body.arguments).toEqual({ tool: 'search-docs', arguments: { phrase: 'report' } })
  })

  it('notes server-side truncation in the rendered result', async () => {
    const { ctx } = await setup(standardHandler({
      execute: () => json({
        requestId: 'req-2',
        traceId: 'trace-2',
        status: 'ok',
        content: [{ type: 'text', text: 'partial rows' }],
        truncated: true,
      }),
    }))
    await ctx.skills.list({})
    const result = await executeCall(ctx, gsServerSkills.RUN_DATA_QUERY_TOOL, {
      skill: 'sales-query',
      query: 'top-sales',
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'partial rows\n\n[The server truncated this result; narrow the parameters if more rows are needed.]',
    })
  })

  it('rejects a skill absent from the effective catalog', async () => {
    const { ctx, bridge } = await setup(standardHandler())
    await ctx.skills.list({})
    const result = await executeCall(ctx, gsServerSkills.RUN_DATA_QUERY_TOOL, {
      skill: 'unknown-skill',
      query: 'top-sales',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'skill "unknown-skill" is not an available data-query skill in the current catalog',
    )
    expect(bridge.requests.some(request => request.path.endsWith('/execute'))).toBe(false)
  })

  it('invalidates the catalog on definition_changed so the next list refetches', async () => {
    const { ctx, bridge } = await setup(standardHandler({
      execute: () => json({
        requestId: 'req-3',
        traceId: 'trace-3',
        status: 'error',
        error: { code: 'definition_changed', message: 'definition moved' },
      }),
    }))
    await ctx.skills.list({})
    const beforeCatalogFetches = bridge.count('/api/v1/skills/catalog')
    const result = await executeCall(ctx, gsServerSkills.RUN_DATA_QUERY_TOOL, {
      skill: 'sales-query',
      query: 'top-sales',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('the skill definition changed on the server')
    await ctx.skills.list({})
    expect(bridge.count('/api/v1/skills/catalog')).toBeGreaterThan(beforeCatalogFetches)
  })

  it('unregisters the bridge tools when a refetch empties the catalog', async () => {
    let catalog: unknown = CATALOG
    const { ctx } = await setup((path) => {
      if (path === '/api/v1/skills/catalog') return json(catalog)
      return standardHandler()(path)
    })
    await ctx.skills.list({})
    expect(ctx.tools.get(gsServerSkills.RUN_DATA_QUERY_TOOL)).toBeDefined()
    catalog = { skills: [] }
    ctx.emit('gs-server/client-config-changed', CLIENT_CONFIG)
    await ctx.skills.list({})
    expect(ctx.tools.get(gsServerSkills.RUN_DATA_QUERY_TOOL)).toBeUndefined()
    expect(ctx.tools.get(gsServerSkills.RUN_MCP_SKILL_TOOL)).toBeUndefined()
  })

  it('registers the bridge for a gated-only catalog but refuses execution outside a private session', async () => {
    const { ctx, bridge } = await setup(standardHandler({
      catalog: { skills: [ZHIDU_CATALOG_ENTRY] },
    }))
    const skills = await ctx.skills.list({})
    const gated = skills.find(skill => skill.name === 'zhidu-knowledge')
    expect(gated?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
    // A gated-only catalog still registers the bridge: private sessions
    // execute through it; the per-call policy check is the gate.
    expect(ctx.tools.get(gsServerSkills.RUN_MCP_SKILL_TOOL)).toBeDefined()
    const result = await executeCall(ctx, gsServerSkills.RUN_MCP_SKILL_TOOL, {
      skill: 'zhidu-knowledge',
      tool: 'search-rules',
      arguments: { phrase: 'rules' },
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'skill "zhidu-knowledge" requires a trusted session and cannot execute in the current session',
    )
    expect(bridge.requests.some(request => request.path.endsWith('/execute'))).toBe(false)
  })

  it('keeps the tools hidden while signed out', async () => {
    const { ctx, bridge } = await setup(standardHandler())
    bridge.accessToken = undefined
    await ctx.skills.list({})
    expect(ctx.tools.get(gsServerSkills.RUN_DATA_QUERY_TOOL)).toBeUndefined()
  })
})

describe('gated trusted-only lane', () => {
  const gatedCatalog = { skills: [ZHIDU_CATALOG_ENTRY] }

  it('mounts the lane into a private agent scope and re-checks privacy per load', async () => {
    const policy = new SensitivePolicyCore()
    const { ctx } = await setup(standardHandler({ catalog: gatedCatalog }))
    ctx.provide('sensitivePolicy', policy)
    await ctx.skills.list({})
    const agent = fakeAgent('s-private')
    const scope = createScope(ctx, agent)
    ctx.gsServerSkillGate.mountPrivateLane(scope.ctx)
    // The scoped view serves the gated skill as invocable…
    const scopedEntry = (await ctx.skills.list({ scope: agent }))
      .find(skill => skill.name === 'zhidu-knowledge')
    expect(scopedEntry).toMatchObject({
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'gsclaw-server-gated',
    })
    // …while the global view keeps it non-invocable.
    const globalEntry = (await ctx.skills.list({})).find(skill => skill.name === 'zhidu-knowledge')
    expect(globalEntry?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
    // The load re-checks the session against the policy core per call.
    expect(await ctx.skills.get('zhidu-knowledge', { scope: agent })).toBeUndefined()
    policy.enterPrivate('s-private')
    const definition = await ctx.skills.get('zhidu-knowledge', { scope: agent })
    expect(definition?.content).toContain('Consult the policy knowledge base.')
    expect(definition?.content).toContain('## Available tools (call via `run_mcp_skill`)')
  })

  it('refuses a gated execution from a non-private session', async () => {
    const policy = new SensitivePolicyCore()
    const { ctx, bridge } = await setup(standardHandler({ catalog: gatedCatalog }))
    ctx.provide('sensitivePolicy', policy)
    await ctx.skills.list({})
    const result = await executeCall(ctx, gsServerSkills.RUN_MCP_SKILL_TOOL, {
      skill: 'zhidu-knowledge',
      tool: 'search-rules',
      arguments: { phrase: 'rules' },
    }, fakeAgent('s-standard'))
    expect(result.isError).toBe(true)
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('requires a trusted session')
    expect(bridge.requests.some(request => request.path.endsWith('/execute'))).toBe(false)
  })

  it('executes a gated skill from a private session with its session id and the audit header', async () => {
    const policy = new SensitivePolicyCore()
    policy.enterPrivate('s-private')
    const { ctx, bridge } = await setup(standardHandler({ catalog: gatedCatalog }))
    ctx.provide('sensitivePolicy', policy)
    await ctx.skills.list({})
    const result = await executeCall(ctx, gsServerSkills.RUN_MCP_SKILL_TOOL, {
      skill: 'zhidu-knowledge',
      tool: 'search-rules',
      arguments: { phrase: 'rules' },
    }, fakeAgent('s-private'))
    expect(result.isError).toBe(false)
    const executeRequest = bridge.requests.find(request => request.path === '/api/v1/skills/zhidu-knowledge/execute')
    const body = JSON.parse(typeof executeRequest?.init?.body === 'string' ? executeRequest.init.body : '') as Record<string, unknown>
    expect(body.sessionId).toBe('s-private')
    expect(body.definitionRevision).toBe('rev-z1')
    expect(body.arguments).toEqual({ tool: 'search-rules', arguments: { phrase: 'rules' } })
    expect(executeRequest?.init?.headers).toMatchObject({ 'x-gsclaw-sensitive': '1' })
  })

  it('marks a private session’s standard-skill execution with its session id and the audit header', async () => {
    const policy = new SensitivePolicyCore()
    policy.enterPrivate('s-private')
    const { ctx, bridge } = await setup(standardHandler())
    ctx.provide('sensitivePolicy', policy)
    await ctx.skills.list({})
    const result = await executeCall(ctx, gsServerSkills.RUN_DATA_QUERY_TOOL, {
      skill: 'sales-query',
      query: 'top-sales',
      params: { limit: 5 },
    }, fakeAgent('s-private'))
    expect(result.isError).toBe(false)
    const executeRequest = bridge.requests.find(request => request.path === '/api/v1/skills/sales-query/execute')
    const body = JSON.parse(typeof executeRequest?.init?.body === 'string' ? executeRequest.init.body : '') as Record<string, unknown>
    expect(body.sessionId).toBe('s-private')
    expect(body.definitionRevision).toBe('rev-1')
    expect(executeRequest?.init?.headers).toMatchObject({ 'x-gsclaw-sensitive': '1' })
  })

  it('keeps a standard session’s execution free of the audit header', async () => {
    const policy = new SensitivePolicyCore()
    const { ctx, bridge } = await setup(standardHandler())
    ctx.provide('sensitivePolicy', policy)
    await ctx.skills.list({})
    const result = await executeCall(ctx, gsServerSkills.RUN_DATA_QUERY_TOOL, {
      skill: 'sales-query',
      query: 'top-sales',
      params: { limit: 5 },
    }, fakeAgent('s-standard'))
    expect(result.isError).toBe(false)
    const executeRequest = bridge.requests.find(request => request.path === '/api/v1/skills/sales-query/execute')
    const body = JSON.parse(typeof executeRequest?.init?.body === 'string' ? executeRequest.init.body : '') as Record<string, unknown>
    expect(body.sessionId).toBe('s-standard')
    expect(executeRequest?.init?.headers).toEqual({ 'content-type': 'application/json' })
  })
})
