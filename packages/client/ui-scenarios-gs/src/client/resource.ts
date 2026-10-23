/** Scenario-shortcuts resource provider with abortable sequential polling. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { ScenarioShortcutsApi } from './api.ts'
import type {} from './contract.ts'

/** Fixed address of the root-independent GS scenario configuration. */
export const SCENARIO_SHORTCUTS_ADDRESS = 'dsh-resource://gs-scenarios/shortcuts'

function waitForNextPoll(intervalMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(false); return }
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, intervalMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function failure(cause: unknown): RemoteError<'gateway/internal'> {
  const message = cause instanceof Error ? cause.message : String(cause)
  return new RemoteError('gateway/internal', message, {}, { cause })
}

/**
 * Create the scenario configuration provider.
 * @param api - authenticated loopback API; every request receives the stream signal.
 * @param refreshIntervalMs - delay between settled polls.
 * @returns a provider whose initial value selects defaults and whose failures retain the last successful value.
 */
export function createScenarioShortcutsResource(
  api: ScenarioShortcutsApi,
  refreshIntervalMs: number,
): ResourceProvider<'gs-scenarios'> {
  return {
    protocol: 'gs-scenarios',
    async *open(_address, { signal }) {
      if (signal.aborted) return
      yield { ok: true as const, value: undefined }
      while (!signal.aborted) {
        try {
          const value = await api.fetchScenarioShortcuts(signal)
          if (signal.aborted) return
          yield { ok: true as const, value }
        } catch (cause: unknown) {
          if (signal.aborted) return
          yield { ok: false as const, error: failure(cause) }
        }
        if (!await waitForNextPoll(refreshIntervalMs, signal)) return
      }
    },
  }
}
