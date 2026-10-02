/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Profile name an upstream-branded Desktop initializes and boots. */
export const DEFAULT_DESKTOP_PROFILE = 'desktop'

/**
 * Resolve the profile this Desktop build owns: the name baked into the packaged
 * manifest by electron-builder (`dshDesktopProfile`), then the environment for
 * unpackaged development launches, then the upstream default.
 * @param manifest - Packaged application manifest, when the application is packaged.
 * @param env - Launch environment.
 * @returns Validated profile name.
 */
export function resolveDesktopProfileName(
  manifest: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const baked = manifest?.dshDesktopProfile
  const value = (typeof baked === 'string' ? baked : env.DSH_DESKTOP_PROFILE)?.trim() ?? ''
  if (value === '') return DEFAULT_DESKTOP_PROFILE
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(value) || value === 'node_modules') {
    throw new Error(`dsh desktop: invalid Desktop profile name ${JSON.stringify(value)}`)
  }
  return value
}

/** Stable desktop installation paths under the shared Harness home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param dshHome - Harness home shared with npm-installed dsh.
 * @param profileName - Profile this build owns; branded builds keep their state out of the upstream profile.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(
  dshHome: string = resolveDshHome(),
  profileName: string = DEFAULT_DESKTOP_PROFILE,
): DesktopPaths {
  return {
    profile: join(dshHome, 'profiles', profileName),
    lock: join(dshHome, 'profiles', profileName, 'lock'),
  }
}
