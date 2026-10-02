/**
 * The gs-desktop profile composition: the gs-app bundle patch parses through
 * the real loader patch parser and composes over the dsh-base and dsh-web-app
 * layers into the expected rows, and app-boot ships the gs-desktop profile
 * template naming the three bundles in order.
 */

import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { composeEntries, loadOverlayPatches, PROFILE_TEMPLATES } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

const BIN = 'dsh-gs-app-test'

function bundlePatches(pkg: string, files: string[]) {
  return files.map(file => loadOverlayPatches(BIN, fileURLToPath(new URL(`../../${pkg}/${file}`, import.meta.url))))
}

function composedGsDesktopEntries(): { rows: EntryOptions[]; warnings: string[] } {
  const layers = [
    ...bundlePatches('base', ['cordis.patch.yml']),
    ...bundlePatches('web-app', [
      'cordis.patch.yml',
      'presets/standard.patch.yml',
      'presets/ptc.patch.yml',
      'presets/minimal.patch.yml',
      'presets/cordis.patch.yml',
    ]),
    ...bundlePatches('gs-app', ['cordis.patch.yml']),
  ]
  const warnings: string[] = []
  const rows = composeEntries(layers, message => warnings.push(message))
  return { rows, warnings }
}

describe('gs-desktop profile composition', () => {
  it('ships the gs-desktop profile template over base + web-app + gs-app', () => {
    expect(PROFILE_TEMPLATES['gs-desktop']).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-gs-app'],
    })
  })

  it('composes the four gs plugin rows with their canonical identities', () => {
    const { rows, warnings } = composedGsDesktopEntries()
    expect(warnings).toEqual([])
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('gs-server')?.name).toBe('@deepseek-ai/dsh-gs-server')
    expect(byId.get('llm-gs-gateway')?.name).toBe('@deepseek-ai/dsh-llm-gs-gateway')
    expect(byId.get('sensitive-policy')?.name).toBe('@deepseek-ai/dsh-sensitive-policy')
    expect(byId.get('gs-server-skills')?.name).toBe('@deepseek-ai/dsh-gs-server-skills')
    const vision = byId.get('gs-vision-bridge')
    expect(vision?.name).toBe('@deepseek-ai/dsh-gs-app/vision-bridge')
    expect(vision?.config).not.toHaveProperty('modelId')
    expect(vision?.config).not.toHaveProperty('providerId')
  })

  it('wires gs-server state beside the profile and reports the build version', () => {
    const { rows } = composedGsDesktopEntries()
    const config = rows.find(row => row.id === 'gs-server')?.config as Record<string, unknown>
    // `!!js` scalars stay expression nodes until the Loader activates the row.
    expect(config.stateDir).toEqual({ __jsExpr: "ctx.get('profileContext').dir + '/gs-server'" })
    expect(config.clientVersion).toEqual({ __jsExpr: "process.env.DSH_CLIENT_VERSION ?? '0.0.0-cli'" })
  })

  it('pins the 国盛证券办公助理 persona and drops the harness opener', () => {
    const { rows } = composedGsDesktopEntries()
    const systemPrompt = rows.find(row => row.id === 'system-prompt')
    const config = systemPrompt?.config as Record<string, unknown>
    expect(config.includeHarnessIdentity).toBe(false)
    expect(config.personaPrefix).toContain('你是国盛证券的办公助理')
    expect(rows.find(row => row.id === 'gs-prompt-language')?.name).toBe('@deepseek-ai/dsh-gs-app/prompt-language')
    expect(config.personaSuffix).toBe('Your working directory is {{cwd}}.')
  })

  it('keeps the proxy-only model posture', () => {
    const { rows } = composedGsDesktopEntries()
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('llm-deepseek')?.disabled).toBe(true)
    expect(byId.get('ui-settings-models')?.disabled).toBe(true)
    expect(byId.get('session-telemetry-otel')?.disabled).toBe(true)
    expect(byId.get('ui-message-feedback')?.disabled).toBe(true)
    expect(byId.get('command-feedback')?.disabled).toBe(true)
    expect(byId.get('gs-agent-policy')?.name).toBe('@deepseek-ai/dsh-gs-app/agent-policy')
  })

  it('enables the scheduled task service and page for the desktop product', () => {
    const { rows } = composedGsDesktopEntries()
    const byId = new Map(rows.map(row => [row.id, row]))
    expect(byId.get('time-context')?.name).toBe('@deepseek-ai/dsh-time-context')
    expect(byId.get('schedule')?.name).toBe('@deepseek-ai/dsh-schedule')
    expect(byId.get('ui-schedule')?.name).toBe('@deepseek-ai/dsh-client-ui-schedule')
    expect(['time-context', 'schedule', 'ui-schedule'].every(id => byId.get(id)?.disabled !== true)).toBe(true)
  })

  it('leaves the official DeepSeek sidebar brand out of the gs composition', () => {
    const { rows } = composedGsDesktopEntries()
    expect(rows.find(row => row.id === 'ui-brand-official')?.disabled).toBe(true)
    expect(rows.find(row => row.id === 'ui-brand-gs')?.name).toBe('@deepseek-ai/dsh-client-ui-brand-gs')
  })
})
