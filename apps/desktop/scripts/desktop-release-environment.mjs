/** Resolve public release identifiers supplied by the packaging environment. */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { valid } from 'semver'

/** Environment variable that supplies the Electron application identifier. */
export const DESKTOP_APP_ID_ENV = 'DSH_DESKTOP_APP_ID'

/** Environment variable that supplies electron-builder's macOS certificate qualifier. */
export const MACOS_SIGNING_IDENTITY_ENV = 'DSH_DESKTOP_MACOS_SIGNING_IDENTITY'

/** Environment variable that supplies the expected Apple Developer Team ID. */
export const MACOS_TEAM_ID_ENV = 'DSH_DESKTOP_MACOS_TEAM_ID'

/** Environment variable that selects the npm registry used for the bundled runtime install. */
export const NPM_REGISTRY_ENV = 'DSH_DESKTOP_NPM_REGISTRY'

/** Environment variable that overrides the packaged product name; unset keeps the upstream identity. */
export const DESKTOP_PRODUCT_NAME_ENV = 'DSH_DESKTOP_PRODUCT_NAME'

/** Environment variable that overrides the artifact filename prefix; unset keeps the upstream prefix. */
export const DESKTOP_ARTIFACT_BASENAME_ENV = 'DSH_DESKTOP_ARTIFACT_BASENAME'

/** Environment variable that selects the brand asset directory holding the packaged icons. */
export const DESKTOP_BRAND_DIR_ENV = 'DSH_DESKTOP_BRAND_DIR'

/** Environment variable that lets the assisted NSIS installer offer an all-users install. */
export const DESKTOP_NSIS_ALLOW_ALL_USERS_ENV = 'DSH_DESKTOP_NSIS_ALLOW_ALL_USERS'

/** Environment variable that enables the legacy-product uninstall prompt in the Windows installer. */
export const DESKTOP_LEGACY_UNINSTALL_PROMPT_ENV = 'DSH_DESKTOP_LEGACY_UNINSTALL_PROMPT'

/** Environment variable that selects the dsh profile the packaged application initializes and boots. */
export const DESKTOP_PROFILE_ENV = 'DSH_DESKTOP_PROFILE'

/** Product name of an unbranded upstream build. */
export const DEFAULT_DESKTOP_PRODUCT_NAME = 'DeepSeek Harness'

/** Artifact filename prefix of an unbranded upstream build. */
export const DEFAULT_DESKTOP_ARTIFACT_BASENAME = 'deepseek-harness'

/** Profile an unbranded upstream build initializes and boots. */
export const DEFAULT_DESKTOP_PROFILE = 'desktop'

const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/'

const APPLE_API_KEY_ENV = 'APPLE_API_KEY'
const APPLE_API_KEY_ID_ENV = 'APPLE_API_KEY_ID'
const APPLE_API_ISSUER_ENV = 'APPLE_API_ISSUER'
const APPLE_ID_ENV = 'APPLE_ID'
const APPLE_APP_SPECIFIC_PASSWORD_ENV = 'APPLE_APP_SPECIFIC_PASSWORD'
const APPLE_TEAM_ID_ENV = 'APPLE_TEAM_ID'
const APPLE_KEYCHAIN_ENV = 'APPLE_KEYCHAIN'
const APPLE_KEYCHAIN_PROFILE_ENV = 'APPLE_KEYCHAIN_PROFILE'

/**
 * Read one required non-empty environment variable.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {string} name - Required variable name.
 * @returns {string} Trimmed variable value.
 */
function requireEnvironmentValue(env, name) {
  const value = env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop release environment: ${name} must be set to a non-empty value`)
  }
  return value
}

/**
 * Resolve the npm registry used to materialize the bundled runtime and its external dependencies.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {string} Registry origin; the public registry unless a local mirror is configured.
 */
export function resolveNpmRegistry(env) {
  const configured = env[NPM_REGISTRY_ENV]?.trim() ?? ''
  if (configured === '') return DEFAULT_NPM_REGISTRY
  let url
  try { url = new URL(configured) }
  catch { throw new Error(`desktop release environment: ${NPM_REGISTRY_ENV} must be an HTTPS origin`) }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error(`desktop release environment: ${NPM_REGISTRY_ENV} must be an HTTPS origin without credentials, path, query, or fragment`)
  }
  return url.origin
}

/**
 * Resolve and validate the application identifier shared by every platform target.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {string} Reverse-DNS application identifier.
 */
export function resolveDesktopAppId(env) {
  const appId = requireEnvironmentValue(env, DESKTOP_APP_ID_ENV)
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u.test(appId)) {
    throw new Error(`desktop release environment: ${DESKTOP_APP_ID_ENV} must be a reverse-DNS identifier`)
  }
  return appId
}

/**
 * Resolve the packaged product name, defaulting to the upstream DeepSeek Harness identity.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {string} Non-empty product name without control characters.
 */
export function resolveDesktopProductName(env) {
  const value = env[DESKTOP_PRODUCT_NAME_ENV]?.trim()
  if (value === undefined || value === '') return DEFAULT_DESKTOP_PRODUCT_NAME
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
  if (/[\0-\x1f\x7f]/u.test(value)) {
    throw new Error(`desktop release environment: ${DESKTOP_PRODUCT_NAME_ENV} must not contain control characters`)
  }
  return value
}

/**
 * Resolve the artifact filename prefix, defaulting to the upstream prefix.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {string} Lowercase hyphen-separated artifact basename.
 */
export function resolveDesktopArtifactBasename(env) {
  const value = env[DESKTOP_ARTIFACT_BASENAME_ENV]?.trim()
  if (value === undefined || value === '') return DEFAULT_DESKTOP_ARTIFACT_BASENAME
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new Error(`desktop release environment: ${DESKTOP_ARTIFACT_BASENAME_ENV} must be lowercase hyphen-separated ASCII`)
  }
  return value
}

/**
 * Resolve the dsh profile the packaged application initializes and boots, defaulting to `desktop`.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {string} Validated profile name.
 */
export function resolveDesktopProfile(env) {
  const value = env[DESKTOP_PROFILE_ENV]?.trim()
  if (value === undefined || value === '') return DEFAULT_DESKTOP_PROFILE
  if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(value) || value === 'node_modules') {
    throw new Error(`desktop release environment: ${DESKTOP_PROFILE_ENV} must be a valid profile name`)
  }
  return value
}

/**
 * Resolve the GS product's release version independently of the bundled Harness runtime.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {string} runtimeVersion - Upstream runtime version.
 * @returns {string} Product release version used by artifact names and update comparisons.
 */
export function resolveDesktopProductVersion(env, runtimeVersion) {
  if (resolveDesktopProfile(env) !== 'gs-desktop') return runtimeVersion
  const product = JSON.parse(readFileSync(new URL('../brand/gs/product.json', import.meta.url), 'utf8'))
  if (typeof product.version !== 'string' || valid(product.version) !== product.version
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(product.version)) {
    throw new Error('desktop release environment: GS product version must be a canonical stable semver')
  }
  return product.version
}

/**
 * Resolve whether the assisted Windows installer offers the all-users mode. The
 * upstream default keeps the custom per-user flow; branded builds that replace a
 * stock assisted-installer product need the stock mode-choice page so the new
 * package can cover an existing all-users installation.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {boolean} True when the assisted installer may elevate to an all-users install.
 */
export function resolveDesktopNsisAllowAllUsers(env) {
  const value = env[DESKTOP_NSIS_ALLOW_ALL_USERS_ENV]
  if (value === undefined || value === '') return false
  if (!['0', '1'].includes(value)) {
    throw new Error(`desktop release environment: ${DESKTOP_NSIS_ALLOW_ALL_USERS_ENV} must be 0 or 1`)
  }
  return value === '1'
}

/**
 * Resolve whether the Windows installer prompts to remove a legacy installation that
 * shares this appId (the dsh-desktop 2.x product line). The NSIS include reads the
 * same variable at compile time; this resolver only validates the value early.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {boolean} True when the installer offers legacy uninstall before setup.
 */
export function resolveDesktopLegacyUninstallPrompt(env) {
  const value = env[DESKTOP_LEGACY_UNINSTALL_PROMPT_ENV]
  if (value === undefined || value === '') return false
  if (!['0', '1'].includes(value)) {
    throw new Error(`desktop release environment: ${DESKTOP_LEGACY_UNINSTALL_PROMPT_ENV} must be 0 or 1`)
  }
  return value === '1'
}

/**
 * Resolve the brand asset directory, defaulting to the upstream resources directory.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {string} baseDir - Directory that a relative override resolves from (the application root).
 * @returns {string | undefined} Absolute brand directory, or undefined for the upstream default.
 */
export function resolveDesktopBrandDir(env, baseDir) {
  const value = env[DESKTOP_BRAND_DIR_ENV]?.trim()
  if (value === undefined || value === '') return undefined
  const directory = resolve(baseDir, value)
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`desktop release environment: ${DESKTOP_BRAND_DIR_ENV} must name a directory: ${directory}`)
  }
  return directory
}

/**
 * Resolve and validate the public identity expected on a macOS release.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ signingIdentity: string, teamId: string }} Expected certificate qualifier and Team ID.
 */
export function resolveMacOSSigningEnvironment(env) {
  const signingIdentity = requireEnvironmentValue(env, MACOS_SIGNING_IDENTITY_ENV)
  if (signingIdentity.startsWith('Developer ID Application:')) {
    throw new Error(`desktop release environment: ${MACOS_SIGNING_IDENTITY_ENV} must omit the "Developer ID Application:" prefix`)
  }
  const teamId = requireEnvironmentValue(env, MACOS_TEAM_ID_ENV)
  if (!/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new Error(`desktop release environment: ${MACOS_TEAM_ID_ENV} must contain 10 uppercase letters or digits`)
  }
  return { signingIdentity, teamId }
}

/**
 * Resolve one complete credential set accepted by Apple's notary service.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @returns {{ appleId: string, appleIdPassword: string, teamId: string } | { appleApiKey: string, appleApiKeyId: string, appleApiIssuer: string } | { keychainProfile: string, keychain?: string }} Notary credentials without the submitted artifact path.
 */
export function resolveMacOSNotarizationEnvironment(env) {
  const appleIdValues = [env[APPLE_ID_ENV], env[APPLE_APP_SPECIFIC_PASSWORD_ENV], env[APPLE_TEAM_ID_ENV]]
  if (appleIdValues.some(value => value !== undefined)) {
    return {
      appleId: requireEnvironmentValue(env, APPLE_ID_ENV),
      appleIdPassword: requireEnvironmentValue(env, APPLE_APP_SPECIFIC_PASSWORD_ENV),
      teamId: requireEnvironmentValue(env, APPLE_TEAM_ID_ENV),
    }
  }

  const apiKeyValues = [env[APPLE_API_KEY_ENV], env[APPLE_API_KEY_ID_ENV], env[APPLE_API_ISSUER_ENV]]
  if (apiKeyValues.some(value => value !== undefined)) {
    return {
      appleApiKey: requireEnvironmentValue(env, APPLE_API_KEY_ENV),
      appleApiKeyId: requireEnvironmentValue(env, APPLE_API_KEY_ID_ENV),
      appleApiIssuer: requireEnvironmentValue(env, APPLE_API_ISSUER_ENV),
    }
  }

  const keychainProfile = env[APPLE_KEYCHAIN_PROFILE_ENV]?.trim()
  if (keychainProfile !== undefined && keychainProfile !== '') {
    const keychain = env[APPLE_KEYCHAIN_ENV]?.trim()
    return keychain === undefined || keychain === ''
      ? { keychainProfile }
      : { keychainProfile, keychain }
  }

  throw new Error('desktop release environment: macOS packaging requires APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER; APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID; or APPLE_KEYCHAIN_PROFILE')
}
