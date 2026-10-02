/** Skill diagnostics cross the real Loader, registry, preferences, and HTTP route. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { ServerSkillPreferences } from '@deepseek-ai/dsh-gs-server-skills/src/preferences.ts'
import * as routes from '../src/skills-routes.ts'

it('reports individual blockers while preserving the existing enablement gates', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gs-skill-routes-'))
  let root: Context | undefined
  let signedIn = true
  let allowLocalSkillCreate = true
  onTestFinished(async () => { await root?.fiber.dispose(); await rm(home, { recursive: true, force: true }) })
  const dir = join(home, 'profile')
  initProfile(dir, ['test-skills-bundle'])
  const bundle = join(dir, 'node_modules', 'test-skills-bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(home, 'package.json'), '{"name":"test-skills-installation"}\n')
  await writeFile(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-skills-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  await writeFile(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'skills', name: 'cordis:skills' },
    { id: 'web', name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    { id: 'server', name: 'cordis:server' },
    { id: 'routes', name: 'cordis:routes' },
  ] }]))
  await writeFile(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', startedBundles: ['test-skills-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
    installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    root = ctx
    ctx.provide('profileContext', profile)
    Object.assign(ctx.loader.builtins, {
      skills: SkillRegistry, web: WebServer, routes,
      server: { apply(ctx: Context) {
        // The remote server alone is replaced; preferences and HTTP remain production code.
        ctx.provide('gsServer', { sessionView: () => ({ status: signedIn ? 'signed-in' : 'signed-out' }),
          getClientConfig: () => ({ permissions: { allowLocalSkillCreate } }) } as never)
        ctx.provide('gsLocalSkills', { managedRoot: join(home, 'local'), homeRoot: join(home, 'user-local'), refresh() {} })
        ctx.provide('gsServerSkillPreferences', new ServerSkillPreferences({
          root: join(home, 'preferences'), accountKey: () => 'https://gs.example.test#7',
          config: () => undefined, invalidate() {},
          client: {
            meta: async () => ({ skillExecution: { version: 1, policyVersion: 1, types: ['data-query', 'server-mcp'] } }),
            catalog: async () => ({ skills: [
              { name: 'client-skill', runtimeType: 'client', modelPolicy: 'standard' },
              { name: 'private-skill', runtimeType: 'data-query', modelPolicy: 'trusted-only' },
              { name: 'silent-skill', runtimeType: 'server-mcp', modelPolicy: 'standard', defaultEnabled: false },
            ] }),
          } as never,
        }))
      } },
    })
  })
  const origin = `http://127.0.0.1:${ctx.webServer.port}`
  const request = (init: RequestInit = {}) => fetch(origin + '/api/gs-server/skills', {
    ...init, headers: { origin, 'content-type': 'application/json' },
  })
  const localRequest = (init: RequestInit = {}) => fetch(origin + '/api/gs-server/local-skills', {
    ...init, headers: { origin, 'content-type': 'application/json' },
  })
  expect(await (await localRequest()).json()).toMatchObject({ allowCreate: true })
  allowLocalSkillCreate = false
  expect(await (await localRequest()).json()).toMatchObject({ allowCreate: false })
  expect((await localRequest({ method: 'POST', body: JSON.stringify({ name: 'blocked', description: 'Blocked' }) })).status).toBe(403)
  allowLocalSkillCreate = true
  signedIn = false
  expect(await (await localRequest()).json()).toMatchObject({ allowCreate: false })
  expect((await localRequest({ method: 'POST', body: JSON.stringify({ name: 'blocked', description: 'Blocked' }) })).status).toBe(403)
  signedIn = true
  const view: unknown = await (await request()).json()
  expect(view).toMatchObject({ status: 'ok', skills: [
    { name: 'client-skill', enabled: true, available: true, userInvocable: true, modelInvocable: true, runtimeType: 'client' },
    { name: 'private-skill', available: false, modelInvocable: false, policy: 'trusted-only', unavailableReason: 'trusted-session-required' },
    { name: 'silent-skill', enabled: false, available: true, userInvocable: false },
  ] })
  expect((await request({ method: 'POST', body: JSON.stringify({ name: 'private-skill', enabled: true }) })).status).toBe(400)
  expect((await request({ method: 'POST', body: JSON.stringify({ name: 'client-skill', enabled: false }) })).status).toBe(200)
  expect((await request({ method: 'POST', body: JSON.stringify({ name: 'silent-skill', enabled: true }) })).status).toBe(200)
  expect(await (await request()).json()).toMatchObject({ skills: [
    { name: 'client-skill', enabled: false, available: true, userInvocable: false, modelInvocable: false },
    { name: 'private-skill', available: false },
    { name: 'silent-skill', enabled: true, available: true, userInvocable: true, modelInvocable: true },
  ] })
}, 8000)
