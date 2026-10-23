/** Same-origin, strictly parsed reads of the gs-server scenario-shortcuts route. */
import type { GsScenarioShortcutItem, GsScenarioShortcutsSetting } from './contract.ts'

const SCENARIO_SHORTCUTS_PATH = 'api/gs-server/scenario-shortcuts'
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** One failed scenario-shortcuts request, including its HTTP status. */
export class ScenarioShortcutsRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ScenarioShortcutsRequestError'
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function invalid(): Error {
  return new Error('invalid scenario shortcuts response')
}

function requiredText(row: Record<string, unknown>, key: 'id' | 'label'): string {
  const value = row[key]
  if (typeof value !== 'string' || value.trim() === '') throw invalid()
  return value
}

function requiredSkill(row: Record<string, unknown>): string {
  const value = row.skill
  if (typeof value !== 'string' || SKILL_NAME_PATTERN.exec(value)?.[0] !== value) throw invalid()
  return value
}

function parseItem(value: unknown): GsScenarioShortcutItem {
  const row = record(value)
  if (row === undefined) throw invalid()
  if (row.enabled !== undefined && typeof row.enabled !== 'boolean') throw invalid()
  return {
    id: requiredText(row, 'id'),
    label: requiredText(row, 'label'),
    skill: requiredSkill(row),
    ...(typeof row.enabled === 'boolean' ? { enabled: row.enabled } : {}),
  }
}

/**
 * Validate one loopback response.
 * @param value - untrusted response body.
 * @returns undefined for client defaults, null for a hidden list, or the validated server list.
 */
export function parseScenarioShortcutsResponse(value: unknown): GsScenarioShortcutsSetting {
  const envelope = record(value)
  if (envelope === undefined) throw invalid()
  const setting = envelope.scenarioShortcuts
  if (setting === undefined || setting === null) return setting
  const row = record(setting)
  if (row === undefined || typeof row.enabled !== 'boolean' || !Array.isArray(row.items)) throw invalid()
  const items = row.items.map(parseItem)
  if (new Set(items.map(item => item.id)).size !== items.length) throw invalid()
  return { enabled: row.enabled, items }
}

async function get<T>(path: string, parse: (value: unknown) => T, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    redirect: 'error',
    cache: 'no-store',
    method: 'GET',
    signal,
  })
  if (!response.ok) {
    let fallback = ''
    try {
      const row = record(await response.json())
      if (typeof row?.error === 'string') fallback = row.error
    } catch (cause: unknown) {
      // Non-JSON failures retain an empty message; the resource keeps the last good list.
      void cause
    }
    throw new ScenarioShortcutsRequestError(response.status, fallback)
  }
  return parse(await response.json())
}

/** Business face consumed by the resource provider. */
export interface ScenarioShortcutsApi {
  /**
   * Read the current setting; undefined selects defaults and null hides the list.
   * @param signal - aborts the request when the resource loses its last holder.
   */
  readonly fetchScenarioShortcuts: (signal: AbortSignal) => Promise<GsScenarioShortcutsSetting>
}

/**
 * Build the loopback-backed API.
 * @returns the fetch-bound scenario-shortcuts call set.
 */
export function createScenarioShortcutsApi(): ScenarioShortcutsApi {
  return { fetchScenarioShortcuts: signal => get(SCENARIO_SHORTCUTS_PATH, parseScenarioShortcutsResponse, signal) }
}
