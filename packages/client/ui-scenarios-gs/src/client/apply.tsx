/** GS scenario-shortcuts resource and conversation.composer.shortcuts registration. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createScenarioShortcutsApi } from './api.ts'
import { createScenarioShortcutsResource, SCENARIO_SHORTCUTS_ADDRESS } from './resource.ts'
import { en, NS, zh } from './locale.ts'
import { ScenarioShortcuts } from './ScenarioShortcuts.tsx'

/** Required services for dictionary registration, resource ownership, and the scenario-shortcuts slot. */
export const inject = ['slots', 'locale', 'resources']

/** Plugin configuration from cordis.yml. */
export interface Config {
  /** Seconds between configuration polls; defaults to 300. */
  readonly refreshIntervalSeconds?: number
}

const DEFAULT_REFRESH_INTERVAL_SECONDS = 300

function resolveRefreshIntervalSeconds(config: Config | undefined): number {
  const value = config?.refreshIntervalSeconds
  if (value === undefined) return DEFAULT_REFRESH_INTERVAL_SECONDS
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('ui-scenarios-gs: config.refreshIntervalSeconds must be a positive finite number of seconds')
  }
  return value
}

/**
 * Register localized defaults, pin the configuration resource for this plugin, and mount the scenario actions.
 * @param ctx - client root context.
 * @param config - plugin configuration; a non-positive or non-finite interval fails before registration.
 */
export function apply(ctx: ClientContext, config?: Config): void {
  const intervalMs = resolveRefreshIntervalSeconds(config) * 1000
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-scenarios-gs: dictionaries')
  ctx.effect(() => ctx.resources.register(
    createScenarioShortcutsResource(createScenarioShortcutsApi(), intervalMs),
  ), 'ui-scenarios-gs: resource')
  ctx.effect(() => {
    const pin = new AbortController()
    ctx.resources.pin(SCENARIO_SHORTCUTS_ADDRESS, pin.signal)
    return () => { pin.abort() }
  }, 'ui-scenarios-gs: resource pin')
  ctx.slots.inject('conversation.composer.shortcuts', () => ctx.slots.register({
    name: 'conversation.composer.shortcuts',
    id: 'gs-scenarios',
    locale: NS,
  }, ScenarioShortcuts))
}
