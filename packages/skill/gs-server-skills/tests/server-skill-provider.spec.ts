import { describe, expect, it, afterEach } from 'vitest'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillProviderControl, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import { SkillBundleCache, type MaterializedSkillBundle, type SkillBundleFile } from '../src/bundle-cache.ts'
import { createGsServerSkillCatalog } from '../src/catalog.ts'
import type { GsSkillDefinitionResponse } from '../src/contract.ts'
import { GsSkillExecutionClient } from '../src/execution.ts'
import {
  ServerSkillProvider,
  parseSkillExecutionSupport,
  renderRemoteToolListing,
  type GsSessionPolicyView,
  type ServerSkillBundleCache,
} from '../src/server-skill-provider.ts'
import type { GsSkillConfigView, GsServerBridge } from '../src/types.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** Mock `ctx.gsServer` bridge with a routing handler. */
class MockBridge implements GsServerBridge {
  readonly requests: string[] = []
  clientConfig: GsSkillConfigView | undefined
  accessToken: string | undefined = 'test-token'
  constructor(public handler: (path: string, init?: RequestInit) => Response) {}
  getAccessToken(): Promise<string | undefined> {
    return Promise.resolve(this.accessToken)
  }
  fetch(path: string, init?: RequestInit): Promise<Response> {
    this.requests.push(path)
    return Promise.resolve(this.handler(path, init))
  }
  getClientConfig(): GsSkillConfigView | undefined {
    return this.clientConfig
  }
}

const META = {
  skillExecution: { version: 1, types: ['data-query', 'server-mcp'], policyVersion: 1 },
}

const DEFINITION: GsSkillDefinitionResponse = {
  name: 'sales-query',
  version: '1.0.0',
  runtimeType: 'data-query',
  definitionRevision: 'rev-1',
  content: 'Use these query templates to answer sales questions.',
  dataQuery: {
    queries: [{
      name: 'top-sales',
      description: 'Top sales rows.',
      params: [{ name: 'limit', type: 'integer', required: false, description: 'Row cap.' }],
    }],
  },
  modelPolicy: 'standard',
}

/** DEFINITION without its data-query surface (exactOptionalPropertyTypes-safe). */
const { dataQuery: _dataQuerySurface, ...DEFINITION_NO_DATA_QUERY } = DEFINITION

function catalogWith(skills: unknown[]): Response {
  return json({ skills })
}

const SALES_ENTRY = {
  name: 'sales-query',
  displayName: 'Sales Query',
  description: 'Query the sales warehouse.',
  version: '1.0.0',
  runtimeType: 'data-query',
  definitionRevision: 'rev-1',
  modelPolicy: 'standard' as const,
}

const CLIENT_ENTRY = {
  name: 'desktop-skill',
  displayName: 'Desktop Skill',
  description: 'Runs on the client.',
  version: '1.0.0',
  runtimeType: 'client',
  definitionRevision: 'cl:1.0.0:1000:standard',
  modelPolicy: 'standard' as const,
}

const CLIENT_FILES: SkillBundleFile[] = [
  {
    path: 'SKILL.md',
    base64: Buffer.from('---\nname: desktop-skill\ndescription: Runs on the client.\n---\n\nUse the local tool.').toString('base64'),
  },
  { path: 'scripts/run.sh', base64: Buffer.from('#!/bin/sh\n').toString('base64') },
]

/**
 * Minimal in-memory `SkillBundleCache` stub matching the pinned bundle-cache
 * API; the real cache is covered by its own spec.
 */
class StubBundleCache implements ServerSkillBundleCache {
  readonly materializeCalls: string[] = []
  failWith: unknown
  private readonly bundles = new Map<string, MaterializedSkillBundle>()
  materialize(name: string, version: string, files: readonly SkillBundleFile[]): Promise<MaterializedSkillBundle> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith instanceof Error ? this.failWith : new Error('bundle refused', { cause: this.failWith }))
    this.materializeCalls.push(`${name}@${version}`)
    const entry = files.find(file => file.path === 'SKILL.md')
    if (entry === undefined) return Promise.reject(new Error('bundle without SKILL.md'))
    const bundle: MaterializedSkillBundle = {
      path: `/cache/${name}@${version}`,
      body: Buffer.from(entry.base64, 'base64').toString('utf8')
        .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, ''),
    }
    this.bundles.set(`${name}@${version}`, bundle)
    return Promise.resolve(bundle)
  }

  readCached(name: string, version: string): Promise<MaterializedSkillBundle | undefined> {
    return Promise.resolve(this.bundles.get(`${name}@${version}`))
  }
}

/** Execution client carrying the pinned `files()` bundle endpoint. */
class TestExecutionClient extends GsSkillExecutionClient {
  readonly filesCalls: string[] = []
  constructor(
    options: ConstructorParameters<typeof GsSkillExecutionClient>[0],
    private readonly filesHandler: (name: string) => { name: string; files: SkillBundleFile[] },
  ) {
    super(options)
  }

  override files(name: string): Promise<{ name: string; files: SkillBundleFile[] }> {
    this.filesCalls.push(name)
    return Promise.resolve(this.filesHandler(name))
  }
}

function standardHandler(overrides: { meta?: unknown; catalog?: Response; definition?: unknown } = {}) {
  return (path: string): Response => {
    if (path === '/api/v1/meta') return json(overrides.meta ?? META)
    if (path === '/api/v1/skills/catalog') return overrides.catalog ?? catalogWith([SALES_ENTRY])
    if (path === '/api/v1/skills/sales-query/definition') return json(overrides.definition ?? DEFINITION)
    return json({ code: 'not_found', message: `no mock route for ${path}` }, 404)
  }
}

interface Harness {
  provider: ServerSkillProvider
  bridge: MockBridge
  catalog: ReturnType<typeof createGsServerSkillCatalog>
  control: SkillProviderControl & { invalidateCount: number }
  bundleCache: ServerSkillBundleCache
  client: TestExecutionClient
  warnings: string[]
}

function setup(
  handler: (path: string, init?: RequestInit) => Response,
  filesHandler?: (name: string) => { name: string; files: SkillBundleFile[] },
  bundleCache: ServerSkillBundleCache = new StubBundleCache(),
  sessionGeneration: () => number = () => 0,
  policy?: () => GsSessionPolicyView | undefined,
): Harness {
  const bridge = new MockBridge(handler)
  const catalog = createGsServerSkillCatalog()
  const client = new TestExecutionClient(
    { fetch: (path, init) => bridge.fetch(path, init), executeTimeoutMs: 1000 },
    filesHandler ?? ((name) => { throw new Error(`unexpected bundle fetch for ${name}`) }),
  )
  const control: Harness['control'] = {
    signal: new AbortController().signal,
    invalidateCount: 0,
    invalidate() { this.invalidateCount += 1 },
  }
  const warnings: string[] = []
  const provider = new ServerSkillProvider({
    bridge,
    client,
    bundleCache,
    catalog,
    ...(policy === undefined ? {} : { policy }),
    sessionGeneration,
    logger: { warn: (format: string) => { warnings.push(format) } },
  }, control)
  return { provider, bridge, catalog, control, bundleCache, client, warnings }
}

async function listCandidates(provider: ServerSkillProvider): Promise<readonly SkillCandidate[]> {
  const observation = await provider.list({})
  expect(Array.isArray(observation)).toBe(true)
  return observation as readonly SkillCandidate[]
}

describe('parseSkillExecutionSupport', () => {
  it('returns undefined for servers predating the capability', () => {
    expect(parseSkillExecutionSupport({})).toBeUndefined()
    expect(parseSkillExecutionSupport({ skillExecution: null })).toBeUndefined()
  })

  it('intersects advertised types with the bridged runtime types', () => {
    const support = parseSkillExecutionSupport({
      skillExecution: { version: 1, types: ['data-query', 'future-type'], policyVersion: 1 },
    })
    expect(support).toEqual({ supported: true, types: ['data-query'], policyVersion: 1 })
  })
})

describe('renderRemoteToolListing', () => {
  it('renders data-query templates with parameter details', () => {
    const listing = renderRemoteToolListing('sales-query', 'data-query', DEFINITION)
    expect(listing).toContain('## Available query templates (call via `run_data_query`)')
    expect(listing).toContain('`sales-query`')
    expect(listing).toContain('### `top-sales`')
    expect(listing).toContain('`limit` (integer, optional). Row cap.')
  })

  it('renders server-mcp tools with their input schema', () => {
    const listing = renderRemoteToolListing('docs-mcp', 'server-mcp', {
      ...DEFINITION_NO_DATA_QUERY,
      name: 'docs-mcp',
      runtimeType: 'server-mcp',
      mcp: { tools: [{ name: 'search-docs', description: 'Search.', inputSchema: { type: 'object' } }] },
    })
    expect(listing).toContain('## Available tools (call via `run_mcp_skill`)')
    expect(listing).toContain('### `search-docs`')
    expect(listing).toContain('Input schema: {"type":"object"}')
  })

  it('returns an empty string when the definition declares no tool surface', () => {
    expect(renderRemoteToolListing('sales-query', 'data-query', DEFINITION_NO_DATA_QUERY)).toBe('')
  })
})

describe('ServerSkillProvider', () => {
  it('returns an incomplete empty observation while signed out', async () => {
    const { provider, bridge, catalog } = setup(standardHandler())
    bridge.accessToken = undefined
    const observation = await provider.list({})
    expect(observation).toEqual({ candidates: [], complete: false })
    expect(catalog.snapshot().supported).toBe(false)
    expect(bridge.requests).toEqual([])
  })

  it('publishes the effective catalog and invocable candidates after a sync', async () => {
    const { provider, catalog } = setup(standardHandler())
    const candidates = await listCandidates(provider)
    const candidate = candidates.find(entry => entry.name === 'sales-query')
    expect(candidate).toMatchObject({
      name: 'sales-query',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'server',
      provider: 'gsclaw-server',
    })
    const snapshot = catalog.snapshot()
    expect(snapshot.supported).toBe(true)
    expect(snapshot.remotes).toEqual([{
      name: 'sales-query',
      runtimeType: 'data-query',
      definitionRevision: 'rev-1',
      modelPolicy: 'standard',
    }])
    expect(catalog.resolveRemote('sales-query', 'data-query')?.definitionRevision).toBe('rev-1')
  })

  it('yields an empty complete catalog for servers without the capability', async () => {
    const { provider, catalog } = setup(standardHandler({ meta: {} }))
    expect(await provider.list({})).toEqual([])
    expect(catalog.snapshot().supported).toBe(false)
  })

  it('drops every skill while the master switch is off', async () => {
    const { provider, bridge } = setup(standardHandler())
    bridge.clientConfig = { skills: { SKILLs: 'off' } }
    expect(await provider.list({})).toEqual([])
  })

  it('drops per-skill off switches and default-disabled skills', async () => {
    const { provider, bridge } = setup(standardHandler({
      catalog: catalogWith([
        SALES_ENTRY,
        { ...SALES_ENTRY, name: 'switched-off' },
        { ...SALES_ENTRY, name: 'default-off', defaultEnabled: false },
      ]),
    }))
    bridge.clientConfig = { skills: { 'switched-off': 'off' } }
    const candidates = await listCandidates(provider)
    expect(candidates.map(entry => entry.name)).toEqual(['sales-query'])
  })

  it('skips runtime types this client cannot execute', async () => {
    const { provider } = setup(standardHandler({
      catalog: catalogWith([
        SALES_ENTRY,
        { ...SALES_ENTRY, name: 'future-skill', runtimeType: 'future-type' },
      ]),
    }))
    const candidates = await listCandidates(provider)
    expect(candidates.map(entry => entry.name)).toEqual(['sales-query'])
  })

  it('lists client-runtime skills as invocable bundle candidates outside the remote catalog', async () => {
    const { provider, catalog } = setup(standardHandler({
      catalog: catalogWith([SALES_ENTRY, CLIENT_ENTRY]),
    }))
    const candidates = await listCandidates(provider)
    const candidate = candidates.find(entry => entry.name === 'desktop-skill')
    expect(candidate).toMatchObject({
      name: 'desktop-skill',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'server',
      provider: 'gsclaw-server',
      metadata: {
        runtimeType: 'client',
        execution: 'desktop',
        version: '1.0.0',
        definitionRevision: 'cl:1.0.0:1000:standard',
      },
    })
    // Client skills never join the server-executed catalog the bridge reads.
    expect(catalog.snapshot().remotes.map(entry => entry.name)).toEqual(['sales-query'])
  })

  it('refreshes client bundles under current authenticated authorization on every load', async () => {
    const bundleCache = new StubBundleCache()
    const { provider, client } = setup(standardHandler({
      catalog: catalogWith([CLIENT_ENTRY]),
    }), name => ({ name, files: CLIENT_FILES }), bundleCache)
    const candidates = await listCandidates(provider)
    const candidate = candidates.find(entry => entry.name === 'desktop-skill')
    expect(candidate).toBeDefined()
    const definition = await provider.get(candidate as SkillCandidate, { signal: new AbortController().signal })
    expect(definition?.content).toContain('Use the local tool.')
    expect(definition?.content).not.toContain('---')
    expect(definition?.resourceBase).toEqual({ kind: 'directory', path: '/cache/desktop-skill@1.0.0' })
    expect(definition?.path).toBe(join('/cache/desktop-skill@1.0.0', 'SKILL.md'))
    expect(definition?.metadata).toMatchObject({ execution: 'desktop', definitionRevision: 'cl:1.0.0:1000:standard' })
    expect(client.filesCalls).toEqual(['desktop-skill'])
    expect(bundleCache.materializeCalls).toEqual(['desktop-skill@1.0.0'])
    // The second load rechecks the server instead of trusting a stale bundle.
    const again = await provider.get(candidate as SkillCandidate, {})
    expect(again?.content).toBe(definition?.content)
    expect(client.filesCalls).toEqual(['desktop-skill', 'desktop-skill'])
    expect(bundleCache.materializeCalls).toEqual(['desktop-skill@1.0.0', 'desktop-skill@1.0.0'])
  })

  it('materializes a client bundle through the real on-disk cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gs-skill-bundle-'))
    tempDirs.push(root)
    const { provider, client } = setup(standardHandler({
      catalog: catalogWith([CLIENT_ENTRY]),
    }), name => ({ name, files: CLIENT_FILES }), new SkillBundleCache(root))
    const candidates = await listCandidates(provider)
    const candidate = candidates.find(entry => entry.name === 'desktop-skill')
    expect(candidate).toBeDefined()
    const definition = await provider.get(candidate as SkillCandidate, {})
    const directory = join(root, 'desktop-skill@1.0.0')
    expect(definition?.content).toContain('Use the local tool.')
    expect(definition?.resourceBase).toEqual({ kind: 'directory', path: directory })
    // The bundle really landed on disk, entry document and payload file alike.
    expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toContain('name: desktop-skill')
    expect(await readFile(join(directory, 'scripts', 'run.sh'), 'utf8')).toContain('#!/bin/sh')
    // A second load refreshes the on-disk bundle from the authenticated server.
    expect(await provider.get(candidate as SkillCandidate, {})).toBeDefined()
    expect(client.filesCalls).toEqual(['desktop-skill', 'desktop-skill'])
  })

  it('lists a trusted-only client skill as non-invocable and refuses its body', async () => {
    const { provider, client } = setup(standardHandler({
      catalog: catalogWith([{ ...CLIENT_ENTRY, modelPolicy: 'trusted-only' }]),
    }), name => ({ name, files: CLIENT_FILES }))
    const candidates = await listCandidates(provider)
    const gated = candidates.find(entry => entry.name === 'desktop-skill')
    expect(gated?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
    expect(gated?.metadata?.policy).toBe('trusted-only')
    expect(await provider.get(gated as SkillCandidate, {})).toBeUndefined()
    expect(client.filesCalls).toEqual([])
  })

  it('refuses a client candidate when the bundle fetch fails', async () => {
    const { provider } = setup(standardHandler({
      catalog: catalogWith([CLIENT_ENTRY]),
    }), () => { const cause: unknown = 'files endpoint down'; throw cause })
    const candidates = await listCandidates(provider)
    const candidate = candidates.find(entry => entry.name === 'desktop-skill')
    expect(await provider.get(candidate as SkillCandidate, {})).toBeUndefined()
  })

  it('discards a client bundle fetched across a session switch', async () => {
    let generation = 0
    const { provider } = setup(standardHandler({
      catalog: catalogWith([CLIENT_ENTRY]),
    }), (name) => {
      // The sign-out lands mid-fetch.
      generation += 1
      return { name, files: CLIENT_FILES }
    }, new StubBundleCache(), () => generation)
    const candidates = await listCandidates(provider)
    const candidate = candidates.find(entry => entry.name === 'desktop-skill')
    expect(await provider.get(candidate as SkillCandidate, {})).toBeUndefined()
  })

  it('refuses a client bundle answering under another name', async () => {
    const { provider } = setup(standardHandler({
      catalog: catalogWith([CLIENT_ENTRY]),
    }), () => ({ name: 'other-skill', files: CLIENT_FILES }))
    const candidates = await listCandidates(provider)
    const candidate = candidates.find(entry => entry.name === 'desktop-skill')
    expect(await provider.get(candidate as SkillCandidate, {})).toBeUndefined()
  })

  it('refuses a client bundle the cache rejects', async () => {
    const bundleCache = new StubBundleCache()
    const { provider } = setup(standardHandler({
      catalog: catalogWith([CLIENT_ENTRY]),
    }), name => ({ name, files: CLIENT_FILES }), bundleCache)
    const candidates = await listCandidates(provider)
    const candidate = candidates.find(entry => entry.name === 'desktop-skill')
    bundleCache.failWith = new Error('bundle refused')
    expect(await provider.get(candidate as SkillCandidate, {})).toBeUndefined()
    // A non-Error refusal takes the same path.
    bundleCache.failWith = 'bundle refused'
    expect(await provider.get(candidate as SkillCandidate, {})).toBeUndefined()
  })

  it('refuses malformed or unsafe client locators', async () => {
    const { provider } = setup(standardHandler(), name => ({ name, files: CLIENT_FILES }))
    const base: SkillCandidate = {
      name: 'desktop-skill',
      description: 'Runs on the client.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'server',
      provider: 'gsclaw-server',
      rank: 700,
      locator: { kind: 'client', name: 'desktop-skill', version: '1.0.0', revision: 'cl:1.0.0:1000:standard', policy: 'standard' },
    }
    // A metadata-less candidate still loads through the bundle path.
    expect((await provider.get(base, {}))?.name).toBe('desktop-skill')
    expect(await provider.get({ ...base, locator: null }, {})).toBeUndefined()
    expect(await provider.get({ ...base, locator: { kind: 'remote' } }, {})).toBeUndefined()
    expect(await provider.get({ ...base, locator: { kind: 'client' } }, {})).toBeUndefined()
    expect(await provider.get({ ...base, locator: { kind: 'client', name: 1, version: '1.0.0', revision: '', policy: 'standard' } }, {})).toBeUndefined()
    expect(await provider.get({ ...base, locator: { kind: 'client', name: 'desktop-skill', version: 1, revision: '', policy: 'standard' } }, {})).toBeUndefined()
    expect(await provider.get({ ...base, locator: { kind: 'client', name: 'desktop-skill', version: '1.0.0', revision: 1, policy: 'standard' } }, {})).toBeUndefined()
    expect(await provider.get({ ...base, locator: { kind: 'client', name: 'desktop-skill', version: '1.0.0', revision: '', policy: 'wildcard' } }, {})).toBeUndefined()
    expect(await provider.get({ ...base, locator: { kind: 'client', name: 'BAD NAME', version: '1.0.0', revision: '', policy: 'standard' } }, {})).toBeUndefined()
    expect(await provider.get({ ...base, locator: { kind: 'client', name: 'desktop-skill', version: '../escape', revision: '', policy: 'standard' } }, {})).toBeUndefined()
  })

  it('lists trusted-only skills as non-invocable and keeps them out of the remote catalog', async () => {
    const { provider, catalog } = setup(standardHandler({
      catalog: catalogWith([
        SALES_ENTRY,
        { ...SALES_ENTRY, name: 'secret-query', modelPolicy: 'trusted-only' },
      ]),
    }))
    const candidates = await listCandidates(provider)
    const gated = candidates.find(entry => entry.name === 'secret-query')
    expect(gated?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
    expect(gated?.metadata?.policy).toBe('trusted-only')
    expect(catalog.snapshot().remotes.map(entry => entry.name)).toEqual(['sales-query'])
    expect(catalog.resolveRemote('secret-query', 'data-query')).toBeUndefined()
  })

  it('loads a remote definition with the rendered tool listing appended', async () => {
    const { provider, bridge } = setup(standardHandler())
    const candidates = await listCandidates(provider)
    const candidate = candidates.find(entry => entry.name === 'sales-query')
    expect(candidate).toBeDefined()
    const definition = await provider.get(candidate as SkillCandidate, {})
    expect(definition?.content).toContain('Use these query templates to answer sales questions.')
    expect(definition?.content).toContain('## Available query templates (call via `run_data_query`)')
    expect(definition?.metadata).toMatchObject({ execution: 'server', definitionRevision: 'rev-1' })
    // The second load serves the in-memory cache without a refetch.
    const definitionFetches = bridge.requests.filter(path => path.endsWith('/definition')).length
    const again = await provider.get(candidate as SkillCandidate, {})
    expect(again?.content).toBe(definition?.content)
    expect(bridge.requests.filter(path => path.endsWith('/definition')).length).toBe(definitionFetches)
  })

  it('refuses the body of a trusted-only candidate', async () => {
    const { provider } = setup(standardHandler({
      catalog: catalogWith([{ ...SALES_ENTRY, name: 'secret-query', modelPolicy: 'trusted-only' }]),
    }))
    const candidates = await listCandidates(provider)
    const gated = candidates.find(entry => entry.name === 'secret-query')
    expect(gated).toBeDefined()
    expect(await provider.get(gated as SkillCandidate, {})).toBeUndefined()
  })

  it('invalidates the registry and refuses when the definition revision moved', async () => {
    const { provider, control } = setup(standardHandler({
      definition: { ...DEFINITION, definitionRevision: 'rev-2' },
    }))
    const candidates = await listCandidates(provider)
    const candidate = candidates.find(entry => entry.name === 'sales-query')
    expect(candidate).toBeDefined()
    expect(await provider.get(candidate as SkillCandidate, {})).toBeUndefined()
    expect(control.invalidateCount).toBe(1)
  })

  it('refuses when the definition fetch fails', async () => {
    const { provider } = setup(path => path.endsWith('/definition')
      ? json({ code: 'internal', message: 'boom' }, 500)
      : standardHandler()(path))
    const candidates = await listCandidates(provider)
    const candidate = candidates.find(entry => entry.name === 'sales-query')
    expect(candidate).toBeDefined()
    expect(await provider.get(candidate as SkillCandidate, {})).toBeUndefined()
  })

  it('keeps the last catalog and reports incomplete discovery when the sync fails', async () => {
    const { provider, catalog } = setup((path) => {
      if (path === '/api/v1/skills/catalog') return json({ code: 'internal', message: 'boom' }, 500)
      return standardHandler()(path)
    })
    const observation = await provider.list({})
    expect(observation).toEqual({ candidates: [], complete: false })
    expect(catalog.snapshot().remotes).toEqual([])
  })
})

/** Trusted-only server-mcp catalog entry retained for the gated lane. */
const ZHIDU_ENTRY = {
  name: 'zhidu-knowledge',
  displayName: 'Knowledge Base',
  description: 'Consult the policy knowledge base.',
  version: '3.0.0',
  runtimeType: 'server-mcp',
  definitionRevision: 'rev-z1',
  modelPolicy: 'trusted-only' as const,
}

const ZHIDU_DEFINITION: GsSkillDefinitionResponse = {
  name: 'zhidu-knowledge',
  version: '3.0.0',
  runtimeType: 'server-mcp',
  definitionRevision: 'rev-z1',
  content: 'Consult the policy knowledge base.',
  mcp: { tools: [{ name: 'search-rules', description: 'Search rules.', inputSchema: { type: 'object' } }] },
  modelPolicy: 'trusted-only',
}

/** Handler serving the gated-only catalog and its definition. */
function gatedHandler(overrides: { definition?: unknown } = {}) {
  return (path: string): Response => {
    if (path === '/api/v1/meta') return json(META)
    if (path === '/api/v1/skills/catalog') return catalogWith([ZHIDU_ENTRY])
    if (path === '/api/v1/skills/zhidu-knowledge/definition') return json(overrides.definition ?? ZHIDU_DEFINITION)
    return json({ code: 'not_found', message: `no mock route for ${path}` }, 404)
  }
}

/** Scoped lookup options carrying a fake agent scope with the given session id. */
function scopedOptions(sessionId?: string): SkillViewOptions {
  return sessionId === undefined ? {} : { scope: { session: { id: sessionId } } }
}

describe('gated trusted-only lane', () => {
  it('refuses a warm private definition after policy revocation or logout', async () => {
    const { provider, bridge } = setup(gatedHandler(), undefined, new StubBundleCache(), () => 0,
      () => ({ isPrivate: () => true }))
    await listCandidates(provider)
    const candidate = provider.gatedCandidates()[0] as SkillCandidate
    expect(await provider.getGated(candidate, scopedOptions('s-1'))).toBeDefined()
    bridge.clientConfig = { skills: { SKILLs: 'off' } }
    expect(await provider.getGated(candidate, scopedOptions('s-1'))).toBeUndefined()
    bridge.clientConfig = undefined
    bridge.accessToken = undefined
    expect(await provider.getGated(candidate, scopedOptions('s-1'))).toBeUndefined()
    expect(bridge.requests.filter(path => path.endsWith('/definition'))).toHaveLength(1)
  })
  it('retains trusted-only remote entries in the gated catalog list', async () => {
    const { provider, catalog } = setup(standardHandler({
      catalog: catalogWith([SALES_ENTRY, ZHIDU_ENTRY]),
    }))
    const candidates = await listCandidates(provider)
    const gated = candidates.find(entry => entry.name === 'zhidu-knowledge')
    expect(gated?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
    expect(catalog.snapshot().remotes.map(entry => entry.name)).toEqual(['sales-query'])
    expect(catalog.snapshot().gated).toEqual([{
      name: 'zhidu-knowledge',
      runtimeType: 'server-mcp',
      definitionRevision: 'rev-z1',
      modelPolicy: 'trusted-only',
    }])
    expect(catalog.resolveGated('zhidu-knowledge', 'server-mcp')?.definitionRevision).toBe('rev-z1')
    expect(catalog.resolveRemote('zhidu-knowledge', 'server-mcp')).toBeUndefined()
  })

  it('serves invocable gated candidates from the retained gated list', async () => {
    const { provider } = setup(gatedHandler())
    await listCandidates(provider)
    expect(provider.gatedCandidates()).toMatchObject([{
      name: 'zhidu-knowledge',
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'gsclaw-server-gated',
      metadata: { policy: 'trusted-only', runtimeType: 'server-mcp', definitionRevision: 'rev-z1' },
    }])
  })

  it('loads a gated definition only while the lookup session is private', async () => {
    let privateSession = false
    const { provider, bridge } = setup(
      gatedHandler(), undefined, new StubBundleCache(), () => 0,
      () => ({ isPrivate: () => privateSession }),
    )
    await listCandidates(provider)
    const candidate = provider.gatedCandidates()[0] as SkillCandidate
    // A scope-less lookup never resolves gated content.
    expect(await provider.getGated(candidate, scopedOptions())).toBeUndefined()
    expect(await provider.getGated(candidate, scopedOptions('s-1'))).toBeUndefined()
    expect(bridge.requests.some(path => path.endsWith('/definition'))).toBe(false)
    privateSession = true
    const definition = await provider.getGated(candidate, scopedOptions('s-1'))
    expect(definition?.content).toContain('Consult the policy knowledge base.')
    expect(definition?.content).toContain('## Available tools (call via `run_mcp_skill`)')
    // The privacy check runs per load, ahead of the warm definition cache.
    privateSession = false
    expect(await provider.getGated(candidate, scopedOptions('s-1'))).toBeUndefined()
  })

  it('keeps the gated lane closed when no policy core is composed', async () => {
    const { provider, bridge } = setup(gatedHandler())
    await listCandidates(provider)
    const candidate = provider.gatedCandidates()[0] as SkillCandidate
    expect(await provider.getGated(candidate, scopedOptions('s-1'))).toBeUndefined()
    expect(bridge.requests.some(path => path.endsWith('/definition'))).toBe(false)
  })

  it('refuses a gated load whose definition policy moved to standard', async () => {
    const { provider, control } = setup(
      gatedHandler({ definition: { ...ZHIDU_DEFINITION, modelPolicy: 'standard' } }),
      undefined, new StubBundleCache(), () => 0,
      () => ({ isPrivate: () => true }),
    )
    await listCandidates(provider)
    const candidate = provider.gatedCandidates()[0] as SkillCandidate
    expect(await provider.getGated(candidate, scopedOptions('s-1'))).toBeUndefined()
    expect(control.invalidateCount).toBe(1)
  })

  it('refuses a gated load of a non-gated locator', async () => {
    const { provider } = setup(standardHandler())
    await listCandidates(provider)
    const standard = (await listCandidates(provider)).find(entry => entry.name === 'sales-query')
    expect(standard).toBeDefined()
    expect(await provider.getGated(standard as SkillCandidate, scopedOptions('s-1'))).toBeUndefined()
  })

  it('fails loud when the lane scope has no skills registry', () => {
    const { provider } = setup(standardHandler())
    expect(() =>{  provider.mountPrivateLane(new Context()) })
      .toThrow('gs-server-skills: the skills registry is unavailable in the gated lane scope')
  })
})
