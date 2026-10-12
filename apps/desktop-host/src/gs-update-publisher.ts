/** Announces changed server releases without moving server credentials across IPC. */
import type { Context } from '@deepseek-ai/cordis'

/**
 * Signal changed appUpdate configuration; repeated pulls do not produce a feedback loop.
 * @param ctx - Host context receiving login, refresh, and explicit config pulls.
 * @param publish - Private IPC signal containing no configuration or credentials.
 */
export function installGsUpdatePublisher(ctx: Context, publish: () => void): void {
  let previous: string | undefined
  ctx.on('gs-server/client-config-changed', (config) => {
    const next = JSON.stringify(config.appUpdate ?? null)
    if (next === previous) return
    previous = next
    publish()
  })
}
