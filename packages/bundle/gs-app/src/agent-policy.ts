/** Enforce server-owned Agent limits in sandbox resolution and tool dispatch. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-gs-server'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-sensitive-policy'

/** Stable Cordis plugin name. */
export const name = 'gs-agent-policy'
/** Host services whose effective limits this plugin enforces. */
export const inject = ['gsServer', 'sandboxPolicy', 'approval', 'tools', 'sensitivePolicy']

/**
 * Bind live server limits before Agent creation; local presets cannot relax them.
 * Without authenticated policy, tools are denied and the filesystem stays read-only.
 * @param ctx - owning Host policy services.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.sandboxPolicy.constrain(() => {
    const agent = ctx.gsServer.getClientConfig()?.agent
    return agent === undefined || agent.approvalPolicy === 'plan' || agent.sandboxProfile !== 'workspace-write'
      ? 'read-only' : 'workspace-write'
  }), 'GS server sandbox limits')
  ctx.effect(() => ctx.approval.constrain(() => {
    const agent = ctx.gsServer.getClientConfig()?.agent
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
