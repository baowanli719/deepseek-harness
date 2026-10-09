/** Model-list policy decoration and session-scoped electronic-consent dialog. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { createModelRiskApi } from './api.ts'
import { ModelRiskController } from './controller.ts'
import { en, NS, zh } from './locale.ts'
import { ModelRiskActivity } from './ModelRisk.tsx'
import { ModelRiskBadge } from './ModelRiskBadge.tsx'

/** Required services for list decoration and authorization before model selection. */
export const inject = ['slots', 'locale', 'modelDirectories']

/**
 * Register policy decoration, authorization guard, and the disclosure dialog host.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-model-risk-gs: dictionaries')
  const api = createModelRiskApi()
  const controller = new ModelRiskController(api)
  ctx.effect(() => ctx.modelDirectories.registerSelectionGuard((sessionId, selection) => controller.authorize(sessionId, selection)), 'ui-model-risk-gs: selection authorization')
  ctx.effect(() => () => { controller.close() }, 'ui-model-risk-gs: pending consent')
  ctx.slots.inject('model.option.accessory', () => ctx.slots.register({
    name: 'model.option.accessory',
    locale: NS,
    inject: () => ({ readStatus: api.readStatus }),
  }, ModelRiskBadge))
  ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
    name: 'conversation.input.activity',
    locale: NS,
    inject: () => ({ controller }),
  }, ModelRiskActivity))
}
