/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Profile name an upstream-branded Desktop initializes and boots. */
export const DEFAULT_DESKTOP_PROFILE = 'desktop'

/**
 * Resolve the product's data root before preparing profiles or spawning the Host.
 * @param profileName - GS Desktop uses `~/.gs-worker`; other profiles use `~/.dsh`.
 * @param env - A nonblank DSH_HOME overrides either product default.
 * @returns Absolute data root shared by the shell, Host, and plugin subprocesses.
 */
export function resolveDesktopHome(profileName: string, env: NodeJS.ProcessEnv = process.env): string {
  if (profileName === 'gs-desktop' && (env.DSH_HOME?.trim() ?? '') === '') {
    return join(homedir(), '.gs-worker')
  }
  return resolveDshHome(undefined, env)
}

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

/** Stable desktop installation paths under the selected product's home. */
export interface DesktopPaths {
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve every Electron-owned path without changing process environment variables.
 * @param dshHome - Explicit home; omission uses the selected profile's product default or DSH_HOME.
 * @param profileName - Profile this build owns; branded builds keep their state out of the upstream profile.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(
  dshHome?: string,
  profileName: string = DEFAULT_DESKTOP_PROFILE,
): DesktopPaths {
  const home = dshHome ?? resolveDesktopHome(profileName)
  return {
    profile: join(home, 'profiles', profileName),
    lock: join(home, 'profiles', profileName, 'lock'),
  }
}
