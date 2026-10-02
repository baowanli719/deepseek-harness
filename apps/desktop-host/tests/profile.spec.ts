import { describe, expect, it } from 'vitest'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { desktopHostLaunchEnvironment, resolveDesktopHostProfile } from '../src/index.ts'

describe('desktop host profile selection', () => {
  it('defaults to the upstream desktop profile', () => {
    expect(resolveDesktopHostProfile({})).toBe('desktop')
    expect(resolveDesktopHostProfile({ DSH_DESKTOP_PROFILE: '  ' })).toBe('desktop')
  })

  it('boots the branded profile the Electron shell passes down', () => {
    expect(resolveDesktopHostProfile({ DSH_DESKTOP_PROFILE: 'gs-desktop' })).toBe('gs-desktop')
  })

  it.each(['bad/name', 'node_modules', '..'])('rejects the invalid profile name %s', (value) => {
    expect(() => resolveDesktopHostProfile({ DSH_DESKTOP_PROFILE: value })).toThrow('invalid DSH_DESKTOP_PROFILE')
  })
})

describe('desktop host launch credential', () => {
  const base: LaunchEnvironmentSnapshot = {
    get: (_name: string) => undefined,
    getFrom: (_name, _sources) => undefined,
  }

  it('makes the gs proxy token available to the credential resolver in memory', () => {
    const snapshot = desktopHostLaunchEnvironment('gs-desktop', base, () => 'per-boot-test-token')
    expect(snapshot.get('DSH_GS_LLM_PROXY_TOKEN')).toEqual({ value: 'per-boot-test-token', source: 'process' })
    expect(snapshot.getFrom('DSH_GS_LLM_PROXY_TOKEN', ['process'])).toEqual({
      value: 'per-boot-test-token', source: 'process',
    })
    expect(snapshot.getFrom('DSH_GS_LLM_PROXY_TOKEN', ['project-env'])).toBeUndefined()
  })

  it('does not add the gs credential to the upstream desktop profile', () => {
    expect(desktopHostLaunchEnvironment('desktop', base, () => { throw new Error('unexpected token') })).toBe(base)
  })
})
