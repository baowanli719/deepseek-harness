import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'
import { LocalSkillProvider, normalizeLocalSkillRestrictions } from '../src/index.ts'
import type { GsSkillConfigView, GsServerBridge } from '../src/index.ts'

/** Every temp dir created by this file, removed after each test. */
const tempDirs: string[] = []
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-gs-local-skills-${name}-`))
  tempDirs.push(dir)
  return dir
}

/** Mock `ctx.gsServer` bridge; `fetch` is never exercised by the local provider. */
class MockBridge implements GsServerBridge {
  clientConfig: GsSkillConfigView | undefined
  accessToken: string | undefined = 'test-token'
  getAccessToken(): Promise<string | undefined> {
    return Promise.resolve(this.accessToken)
  }
  fetch(): Promise<Response> {
    return Promise.reject(new Error('local skill provider must not call fetch'))
  }
  getClientConfig(): GsSkillConfigView | undefined {
    return this.clientConfig
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function skillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

async function writeSkill(root: string, name: string, content: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  await writeFile(file, content)
  return file
}

interface Harness {
  provider: LocalSkillProvider
  bridge: MockBridge
  managedRoot: string
  homeRoot: string
}

async function setup(): Promise<Harness> {
  const dir = await tempDir('roots')
  const managedRoot = join(dir, 'managed')
  const homeRoot = join(dir, 'home')
  await mkdir(managedRoot, { recursive: true })
  await mkdir(homeRoot, { recursive: true })
  const bridge = new MockBridge()
  const provider = new LocalSkillProvider(bridge, { managedRoot, homeRoot })
  return { provider, bridge, managedRoot, homeRoot }
}

async function candidateFor(provider: LocalSkillProvider, name: string): Promise<SkillCandidate> {
  const candidates = await provider.list({})
  const candidate = candidates.find(entry => entry.name === name)
  expect(candidate, `candidate ${name}`).toBeDefined()
  return candidate as SkillCandidate
}

describe('normalizeLocalSkillRestrictions', () => {
  it('drops malformed entries individually', () => {
    const valid = { name: 'foo', contentHash: 'a'.repeat(64) }
    const normalized = normalizeLocalSkillRestrictions([
      valid,
      { name: 'Not A Skill', contentHash: 'a'.repeat(64) },
      { name: 'bar', contentHash: 'not-a-hash' },
      'bare-string',
      null,
      { name: 'baz' },
    ])
    expect(normalized).toEqual([valid])
    expect(normalizeLocalSkillRestrictions(undefined)).toEqual([])
    expect(normalizeLocalSkillRestrictions({})).toEqual([])
  })
})

describe('LocalSkillProvider', () => {
  it('lists directory and flat-file skills with directory resource bases', async () => {
    const { provider, managedRoot, homeRoot } = await setup()
    await writeSkill(managedRoot, 'alpha', skillMarkdown('alpha', 'Managed skill.', 'Do alpha.'))
    await writeFile(join(homeRoot, 'beta.md'), skillMarkdown('beta', 'Home skill.', 'Do beta.'))
    const candidates = await provider.list({})
    expect(candidates.map(entry => entry.name).sort()).toEqual(['alpha', 'beta'])
    const alpha = await candidateFor(provider, 'alpha')
    expect(alpha.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(alpha.resourceBase).toEqual({ kind: 'directory', path: join(managedRoot, 'alpha') })
    const beta = await candidateFor(provider, 'beta')
    expect(beta.resourceBase).toEqual({ kind: 'directory', path: homeRoot })
  })

  it('lets the managed root win a same-name conflict against the home root', async () => {
    const { provider, managedRoot, homeRoot } = await setup()
    await writeSkill(managedRoot, 'alpha', skillMarkdown('alpha', 'Managed wins.', 'Managed body.'))
    await writeSkill(homeRoot, 'alpha', skillMarkdown('alpha', 'Home loses.', 'Home body.'))
    const candidates = await provider.list({})
    expect(candidates.filter(entry => entry.name === 'alpha').length).toBe(1)
    const alpha = await candidateFor(provider, 'alpha')
    expect(alpha.description).toBe('Managed wins.')
    expect(alpha.metadata?.root).toBe('managed')
    const definition = await provider.get(alpha, {})
    expect(definition?.content).toBe('Managed body.')
  })

  it('lists nothing while signed out', async () => {
    const { provider, bridge, managedRoot } = await setup()
    await writeSkill(managedRoot, 'alpha', skillMarkdown('alpha', 'Managed skill.', 'Do alpha.'))
    bridge.accessToken = undefined
    expect(await provider.list({})).toEqual([])
    const staleCandidate: SkillCandidate = {
      name: 'alpha',
      description: 'Managed skill.',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'local',
      provider: 'local-skill-provider',
      rank: 0,
      locator: { path: join(managedRoot, 'alpha', 'SKILL.md'), directory: join(managedRoot, 'alpha'), root: 'managed' },
    }
    expect(await provider.get(staleCandidate, {})).toBeUndefined()
  })

  it('lists but refuses every local skill while the admin ban is active', async () => {
    const { provider, bridge, managedRoot } = await setup()
    await writeSkill(managedRoot, 'alpha', skillMarkdown('alpha', 'Managed skill.', 'Do alpha.'))
    bridge.clientConfig = { permissions: { allowLocalSkillCreate: false } }
    const alpha = await candidateFor(provider, 'alpha')
    expect(alpha.invocation).toEqual({ modelInvocable: false, userInvocable: false })
    expect(alpha.metadata?.disabledByAdmin).toBe(true)
    expect(await provider.get(alpha, {})).toBeUndefined()
    bridge.clientConfig = { permissions: { allowLocalSkillCreate: true } }
    const restored = await candidateFor(provider, 'alpha')
    expect(restored.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(await provider.get(restored, {})).toBeDefined()
  })

  it('gates exactly the restricted name+SHA-256 revision as trusted-only', async () => {
    const { provider, bridge, managedRoot } = await setup()
    const content = skillMarkdown('alpha', 'Restricted skill.', 'Original body.')
    await writeSkill(managedRoot, 'alpha', content)
    await writeSkill(managedRoot, 'beta', skillMarkdown('beta', 'Unrestricted skill.', 'Beta body.'))
    bridge.clientConfig = {
      localSkillRestrictions: [{ name: 'alpha', contentHash: sha256(content) }],
    }
    const alpha = await candidateFor(provider, 'alpha')
    expect(alpha.invocation).toEqual({ modelInvocable: false, userInvocable: false })
    expect(alpha.metadata?.policy).toBe('trusted-only')
    expect(await provider.get(alpha, {})).toBeUndefined()
    const beta = await candidateFor(provider, 'beta')
    expect(beta.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(await provider.get(beta, {})).toBeDefined()
  })

  it('does not gate a restriction entry naming another skill or another revision', async () => {
    const { provider, bridge, managedRoot } = await setup()
    const content = skillMarkdown('alpha', 'Plain skill.', 'Alpha body.')
    await writeSkill(managedRoot, 'alpha', content)
    bridge.clientConfig = {
      localSkillRestrictions: [
        { name: 'other-skill', contentHash: sha256(content) },
        { name: 'alpha', contentHash: sha256('some other content') },
      ],
    }
    const alpha = await candidateFor(provider, 'alpha')
    expect(alpha.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(alpha.metadata?.policy).toBeUndefined()
    expect(await provider.get(alpha, {})).toBeDefined()
  })

  it('stops gating a tampered file whose hash no longer matches the restriction', async () => {
    const { provider, bridge, managedRoot } = await setup()
    const original = skillMarkdown('alpha', 'Restricted skill.', 'Original body.')
    const file = await writeSkill(managedRoot, 'alpha', original)
    bridge.clientConfig = {
      localSkillRestrictions: [{ name: 'alpha', contentHash: sha256(original) }],
    }
    expect((await candidateFor(provider, 'alpha')).metadata?.policy).toBe('trusted-only')
    // An edit is a new content revision: the stale restriction no longer
    // matches the freshly computed hash, on list and on load.
    const edited = skillMarkdown('alpha', 'Restricted skill.', 'Tampered body.')
    await writeFile(file, edited)
    const alpha = await candidateFor(provider, 'alpha')
    expect(alpha.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    expect(alpha.metadata?.policy).toBeUndefined()
    const definition = await provider.get(alpha, {})
    expect(definition?.content).toBe('Tampered body.')
    // Re-flagging the new revision gates it again.
    bridge.clientConfig = {
      localSkillRestrictions: [{ name: 'alpha', contentHash: sha256(edited) }],
    }
    const reflagged = await candidateFor(provider, 'alpha')
    expect(reflagged.metadata?.policy).toBe('trusted-only')
    expect(await provider.get(reflagged, {})).toBeUndefined()
  })

  it('never honors a stale candidate after the file content changed under it', async () => {
    const { provider, bridge, managedRoot } = await setup()
    const original = skillMarkdown('alpha', 'Plain skill.', 'Original body.')
    const file = await writeSkill(managedRoot, 'alpha', original)
    const alpha = await candidateFor(provider, 'alpha')
    // The file is edited after listing; a restriction matching the NEW content
    // must still refuse the stale candidate's load.
    const edited = skillMarkdown('alpha', 'Plain skill.', 'Edited body.')
    await writeFile(file, edited)
    bridge.clientConfig = {
      localSkillRestrictions: [{ name: 'alpha', contentHash: sha256(edited) }],
    }
    expect(await provider.get(alpha, {})).toBeUndefined()
  })

  it('skips files without valid frontmatter', async () => {
    const { provider, managedRoot } = await setup()
    await writeSkill(managedRoot, 'alpha', 'no frontmatter at all')
    await writeSkill(managedRoot, 'broken-name', skillMarkdown('Not A Skill', 'Bad name.', 'Body.'))
    await writeSkill(managedRoot, 'valid', skillMarkdown('valid', 'Valid skill.', 'Body.'))
    const candidates = await provider.list({})
    expect(candidates.map(entry => entry.name)).toEqual(['valid'])
  })
})
