/** Enforce server-owned Agent limits in sandbox resolution and tool dispatch. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-gs-server'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sensitive-policy'

/** Stable Cordis plugin name. */
export const name = 'gs-agent-policy'
/** Host services whose effective limits this plugin enforces. */
export const inject = ['gsServer', 'sandboxPolicy', 'approval', 'tools', 'sensitivePolicy']

/** Deployment permission for private sessions to use their selected local file policy. */
export interface Config {
  /** Remove the server filesystem ceiling for private sessions; authentication and plan-only denial remain. */
  privateFullAccess?: boolean
}

/** Private full access is opt-in outside the GS product composition. */
export const Config: z<Config> = z.object({ privateFullAccess: z.boolean().default(false) })

/**
 * Bind live server limits before Agent creation; opted-in private sessions follow their local file preset.
 * Without authenticated policy, tools are denied and the filesystem stays read-only.
 * @param ctx - owning Host policy services.
 * @param config - deployment permission for private-session local presets.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => ctx.sandboxPolicy.constrain((request) => {
    const agent = ctx.gsServer.getClientConfig()?.agent
    if (agent === undefined || agent.approvalPolicy === 'plan') return 'read-only'
    if (config.privateFullAccess && request.session !== undefined && ctx.sensitivePolicy.isPrivate(String(request.session.id))) {
      return 'danger-full-access'
    }
    return agent.sandboxProfile !== 'workspace-write'
      ? 'read-only' : 'workspace-write'
  }), 'GS server sandbox limits')
  ctx.effect(() => ctx.approval.constrain((session) => {
    const agent = ctx.gsServer.getClientConfig()?.agent
    if (agent !== undefined && agent.approvalPolicy !== 'plan'
      && config.privateFullAccess && ctx.sensitivePolicy.isPrivate(String(session.id))) return 'ask'
    return agent === undefined || agent.approvalPolicy === 'plan' || agent.sandboxProfile === 'read-only'
      ? 'never' : 'ask'
  }), 'GS server approval limits')
  ctx.effect(() => ctx.tools.guard(() => {
    const config = ctx.gsServer.getClientConfig()
    if (config === undefined) return 'gsclaw-server authentication and Agent policy are required before tools can execute'
    if (config.agent.approvalPolicy === 'plan') return 'tools are unavailable while the server requires plan-only operation'
    return undefined
  }), 'GS authenticated tool dispatch')
  ctx.on('agent/created', ({ agent }) => {
    const dataClass = ctx.gsServer.getClientConfig()?.agent.dataClass
    if (dataClass === 'sensitive' || dataClass === 'confidential') ctx.sensitivePolicy.enterPrivate(String(agent.session.id))
  })
  ctx.on('gs-server/client-config-changed', (config) => {
    if (config.agent.dataClass !== 'sensitive' && config.agent.dataClass !== 'confidential') return
    const agents = ctx.get('agents')
    if (agents === undefined) return
    for (const agent of agents.list()) ctx.sensitivePolicy.enterPrivate(String(agent.session.id))
  })
}
