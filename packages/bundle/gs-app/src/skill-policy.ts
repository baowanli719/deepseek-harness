/** Skill plugin admission for gs-worker profiles and scoped Agent presets. */
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

const SKILL_PACKAGES = new Map([
  ['skill', '@deepseek-ai/dsh-skill'],
  ['skills', '@deepseek-ai/dsh-skill'],
  ['tool-skill', '@deepseek-ai/dsh-tool-skill'],
  ['skill-badge', '@deepseek-ai/dsh-skill-badge'],
  ['ui-skill', '@deepseek-ai/dsh-client-ui-skill'],
  ['gs-server-skills', '@deepseek-ai/dsh-gs-server-skills'],
  ['gs-skills-routes', '@deepseek-ai/dsh-gs-app/skills-routes'],
  ['ui-skills-gs', '@deepseek-ai/dsh-client-ui-skills-gs'],
])
const ALLOWED_PACKAGES = new Set(SKILL_PACKAGES.values())
const INCLUDES = new Set(['cordis:include', '@deepseek-ai/cordis-plugin-include'])

interface SkillEntry {
  readonly id?: string
  readonly name: string
  readonly config?: unknown
  readonly group?: boolean | null
  readonly disabled?: boolean | null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function skillEntry(value: unknown): value is SkillEntry {
  return record(value) && typeof value.name === 'string'
    && (value.id === undefined || typeof value.id === 'string')
}

function denied(row: SkillEntry): boolean {
  if (INCLUDES.has(row.name)) return true
  if (row.id === 'skill-filesystem' || row.name === '@deepseek-ai/dsh-skill-filesystem') return true
  const pinned = row.id === undefined ? undefined : SKILL_PACKAGES.get(row.id)
  if (pinned !== undefined) return row.name !== pinned
  if (ALLOWED_PACKAGES.has(row.name)) return false
  return /skill/iu.test(row.id ?? '') || /skill/iu.test(row.name)
}

function sanitizeRow<T extends SkillEntry>(row: T): T {
  if (denied(row)) return { ...row, disabled: true, group: false }
  if ((row.group === true || row.name === 'cordis:group'
    || row.name === '@deepseek-ai/cordis-plugin-group') && Array.isArray(row.config)) {
    return { ...row, config: row.config.map((child: unknown) => skillEntry(child) ? sanitizeRow(child) : child) }
  }
  if (record(row.config) && Array.isArray(row.config.plugins)) {
    return { ...row, config: { ...row.config,
      plugins: row.config.plugins.map((child: unknown) => skillEntry(child) ? sanitizeRow(child) : child),
    } }
  }
  return { ...row }
}

/**
 * Admit only the product skill registry, tools, UI, bundled badge, and GS-controlled providers.
 * Generic local discovery, other skill plugins, and nested file Includes stay disabled;
 * Includes are denied because their separately loaded files do not carry this policy.
 * @param entries - Effective rows after all patch layers, or rows about to mount in an Agent scope.
 * @returns Detached rows with denied plugins and their subtrees disabled; input files remain unchanged.
 */
export function sanitizeGsSkillEntries(entries: readonly EntryOptions[]): EntryOptions[] {
  return entries.map(row => sanitizeRow(row))
}
