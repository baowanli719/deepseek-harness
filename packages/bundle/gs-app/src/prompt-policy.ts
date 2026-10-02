/** Office identity applied to every gs-worker profile and preset patch layer. */
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { LANGUAGE_DIRECTIVE } from './prompt-language.ts'

/** Product persona shared by deployment and per-agent preset registrations. */
export const OFFICE_PERSONA = '你是国盛证券的办公助理，为国盛证券员工提供日常办公支持，包括文档撰写与整理、资料查询、数据汇总、会议纪要、流程指引等。回答应当专业、准确、简洁；涉及具体业务数据或内部规定时，以可核实的资料为准，不确定的内容要明确说明，不要臆造。'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function presetConfig(config: unknown): unknown {
  if (!record(config) || !Array.isArray(config.plugins)) return config
  return { ...config, plugins: config.plugins.map((row: EntryOptions) => {
    if (row.name !== '@deepseek-ai/dsh-persona' || !record(row.config)) return row
    // A complete persona suppresses other system sections, including the global language rule.
    const prefix = row.config.complete === true ? `${OFFICE_PERSONA}\n\n${LANGUAGE_DIRECTIVE}` : OFFICE_PERSONA
    return { ...row, config: { ...row.config, prefix } }
  }) }
}

function deploymentConfig(config: unknown): unknown {
  return record(config) ? { ...config, includeHarnessIdentity: false, personaPrefix: OFFICE_PERSONA } : config
}

/**
 * Apply the office identity after bundle, profile, home, and invocation layers are read.
 * Complete presets retain their tool/context choices and carry the language rule in their prefix.
 * @param patches - Ordered patches read by the profile launcher or configuration reload.
 * @returns Detached patches with deployment and preset personas set to the office identity.
 */
export function sanitizeGsPromptPatches(patches: readonly PatchOptions[]): PatchOptions[] {
  return patches.map(patch => ({
    ...patch,
    ...(patch.insert === undefined ? {} : { insert: patch.insert.map(row => ({
      ...row,
      ...(row.id === 'system-prompt' ? { config: deploymentConfig(row.config) }
        : row.name === '@deepseek-ai/dsh-agent-preset' ? { config: presetConfig(row.config) } : {}),
    })) }),
    ...(patch.config === undefined ? {} : { config: patch.id === 'system-prompt'
      ? deploymentConfig(patch.config)
      : presetConfig(patch.config) }),
  }))
}
