/** Same-origin skills catalog for gs-worker's Settings page. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-gs-server'
import { isSameOriginLoopbackRequest } from '@deepseek-ai/dsh-gs-server'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-skill'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-gs-server-skills'

export const name = 'gs-skills-routes'
export const inject = ['gsServer', 'skills', 'webServer', 'gsLocalSkills', 'gsServerSkillPreferences']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/gs-server/skills',
    handler: async (req, res) => {
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('x-content-type-options', 'nosniff')
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, POST')
        res.end(JSON.stringify({ error: 'method not allowed' }))
        return
      }
      const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
      if (!isSameOriginLoopbackRequest(req, origin, req.method !== 'GET')) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      if (ctx.gsServer.sessionView().status !== 'signed-in') {
        if (req.method === 'POST') res.statusCode = 403
        res.end(JSON.stringify({ status: 'signed-out', skills: [] }))
        return
      }
      try {
        if (req.method === 'POST') {
          if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
            res.statusCode = 415
            res.end(JSON.stringify({ error: 'content type must be application/json' }))
            return
          }
          const chunks: Buffer[] = []
          let size = 0
          for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
            size += buffer.byteLength
            if (size > 8192) throw new Error('body too large')
            chunks.push(buffer)
          }
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid request')
          const body = parsed as Record<string, unknown>
          if (typeof body.name !== 'string' || !isSkillName(body.name) || typeof body.enabled !== 'boolean') throw new Error('invalid request')
          await ctx.gsServerSkillPreferences.setEnabled(body.name, body.enabled)
          res.end(JSON.stringify({ updated: true }))
          return
        }
        const [skills, server] = await Promise.all([ctx.skills.list(), ctx.gsServerSkillPreferences.list()])
        const serverNames = new Set(server.map(skill => skill.name))
        res.end(JSON.stringify({
          status: 'ok',
          skills: [
            ...server.map(skill => ({
              name: skill.name, description: skill.description, source: 'server',
              enabled: skill.enabled, available: skill.available,
              runtimeType: skill.runtimeType,
              ...(skill.policy === undefined ? {} : { policy: skill.policy }),
              ...(skill.unavailableReason === undefined ? {} : { unavailableReason: skill.unavailableReason }),
              userInvocable: skill.enabled && skill.available,
              modelInvocable: skill.enabled && skill.available,
            })),
            ...skills.filter(skill => !serverNames.has(skill.name)).map(skill => ({
              name: skill.name,
              description: skill.description,
              source: skill.source,
              userInvocable: skill.invocation.userInvocable,
              modelInvocable: skill.invocation.modelInvocable,
            })),
          ].slice(0, 500),
        }))
      } catch (cause) {
        ctx.logger.warn('gs-skills-routes: catalog read failed: %s', cause instanceof Error ? cause.message : String(cause))
        res.statusCode = req.method === 'POST' ? 400 : 503
        res.end(JSON.stringify({ error: req.method === 'POST' ? 'invalid skill preference request' : 'skills unavailable' }))
      }
    },
  }), 'gs-worker: skills catalog route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/gs-server/local-skills',
    handler: async (req, res) => {
      res.setHeader('cache-control', 'no-store')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('x-content-type-options', 'nosniff')
      const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
      if (!isSameOriginLoopbackRequest(req, origin, req.method !== 'GET')) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: 'forbidden' }))
        return
      }
      if (req.method === 'GET') {
        res.end(JSON.stringify({
          managedRoot: ctx.gsLocalSkills.managedRoot,
          homeRoot: ctx.gsLocalSkills.homeRoot,
          allowCreate: ctx.gsServer.sessionView().status === 'signed-in'
            && ctx.gsServer.getClientConfig()?.permissions.allowLocalSkillCreate !== false,
        }))
        return
      }
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, POST')
        res.end(JSON.stringify({ error: 'method not allowed' }))
        return
      }
      if (ctx.gsServer.sessionView().status !== 'signed-in'
        || ctx.gsServer.getClientConfig()?.permissions.allowLocalSkillCreate === false) {
        res.statusCode = 403
        res.end(JSON.stringify({ error: 'local skill creation unavailable' }))
        return
      }
      if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        res.statusCode = 415
        res.end(JSON.stringify({ error: 'content type must be application/json' }))
        return
      }
      try {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          size += buffer.byteLength
          if (size > 8192) throw new Error('body too large')
          chunks.push(buffer)
        }
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid request')
        const body = parsed as Record<string, unknown>
        if (typeof body.name !== 'string' || !isSkillName(body.name) || typeof body.description !== 'string'
          || body.description.trim().length < 1 || body.description.length > 1024) throw new Error('invalid request')
        const directory = join(ctx.gsLocalSkills.managedRoot, body.name)
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await writeFile(join(directory, 'SKILL.md'),
          `---\nname: ${JSON.stringify(body.name)}\ndescription: ${JSON.stringify(body.description.trim())}\n---\n\n# ${body.name}\n\n${body.description.trim()}\n`,
          { flag: 'wx', mode: 0o600 })
        ctx.gsLocalSkills.refresh()
        res.statusCode = 201
        res.end(JSON.stringify({ created: true }))
      } catch (cause) {
        const exists = (cause as NodeJS.ErrnoException).code === 'EEXIST'
        res.statusCode = exists ? 409 : 400
        res.end(JSON.stringify({ error: exists ? 'skill already exists' : 'invalid local skill request' }))
      }
    },
  }), 'gs-worker: local skills route')
}
