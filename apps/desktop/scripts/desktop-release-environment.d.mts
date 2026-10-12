/** Environment variable that supplies the Electron application identifier. */
export const DESKTOP_APP_ID_ENV: 'DSH_DESKTOP_APP_ID'

/** Environment variable that supplies electron-builder's macOS certificate qualifier. */
export const MACOS_SIGNING_IDENTITY_ENV: 'DSH_DESKTOP_MACOS_SIGNING_IDENTITY'

/** Environment variable that supplies the expected Apple Developer Team ID. */
export const MACOS_TEAM_ID_ENV: 'DSH_DESKTOP_MACOS_TEAM_ID'

/** Environment variable that selects the npm registry used for the bundled runtime install. */
export const NPM_REGISTRY_ENV: 'DSH_DESKTOP_NPM_REGISTRY'

/** Environment variable that overrides the packaged product name; unset keeps the upstream identity. */
export const DESKTOP_PRODUCT_NAME_ENV: 'DSH_DESKTOP_PRODUCT_NAME'

/** Environment variable that overrides the artifact filename prefix; unset keeps the upstream prefix. */
export const DESKTOP_ARTIFACT_BASENAME_ENV: 'DSH_DESKTOP_ARTIFACT_BASENAME'

/** Environment variable that selects the brand asset directory holding the packaged icons. */
export const DESKTOP_BRAND_DIR_ENV: 'DSH_DESKTOP_BRAND_DIR'

/** Environment variable that lets the assisted NSIS installer offer an all-users install. */
export const DESKTOP_NSIS_ALLOW_ALL_USERS_ENV: 'DSH_DESKTOP_NSIS_ALLOW_ALL_USERS'

/** Environment variable that enables the legacy-product uninstall prompt in the Windows installer. */
export const DESKTOP_LEGACY_UNINSTALL_PROMPT_ENV: 'DSH_DESKTOP_LEGACY_UNINSTALL_PROMPT'

/** Environment variable that selects the dsh profile the packaged application initializes and boots. */
export const DESKTOP_PROFILE_ENV: 'DSH_DESKTOP_PROFILE'

/** Product name of an unbranded upstream build. */
export const DEFAULT_DESKTOP_PRODUCT_NAME: 'DeepSeek Harness'

/** Artifact filename prefix of an unbranded upstream build. */
export const DEFAULT_DESKTOP_ARTIFACT_BASENAME: 'deepseek-harness'

/** Profile an unbranded upstream build initializes and boots. */
export const DEFAULT_DESKTOP_PROFILE: 'desktop'

/** Public identity expected on a macOS release. */
export interface MacOSSigningEnvironment {
  readonly signingIdentity: string
  readonly teamId: string
}

/** Apple ID credentials accepted by notarytool. */
export interface MacOSAppleIdNotarizationEnvironment {
  readonly appleId: string
  readonly appleIdPassword: string
  readonly teamId: string
}

/** App Store Connect API credentials accepted by notarytool. */
export interface MacOSApiKeyNotarizationEnvironment {
  readonly appleApiKey: string
  readonly appleApiKeyId: string
  readonly appleApiIssuer: string
}

/** Keychain profile accepted by notarytool. */
export interface MacOSKeychainNotarizationEnvironment {
  readonly keychainProfile: string
  readonly keychain?: string
}

/** One complete credential strategy accepted by notarytool. */
export type MacOSNotarizationEnvironment =
  | MacOSAppleIdNotarizationEnvironment
  | MacOSApiKeyNotarizationEnvironment
  | MacOSKeychainNotarizationEnvironment

/**
 * Resolve and validate the application identifier shared by every platform target.
 * @param env - Packaging environment.
 * @returns Reverse-DNS application identifier.
 */
export function resolveDesktopAppId(env: NodeJS.ProcessEnv): string

/**
 * Resolve the packaged product name, defaulting to the upstream DeepSeek Harness identity.
 * @param env - Packaging environment.
 * @returns Non-empty product name without control characters.
 */
export function resolveDesktopProductName(env: NodeJS.ProcessEnv): string

/**
 * Resolve the artifact filename prefix, defaulting to the upstream prefix.
 * @param env - Packaging environment.
 * @returns Lowercase hyphen-separated artifact basename.
 */
export function resolveDesktopArtifactBasename(env: NodeJS.ProcessEnv): string

/**
 * Resolve the dsh profile the packaged application initializes and boots, defaulting to `desktop`.
 * @param env - Packaging environment.
 * @returns Validated profile name.
 */
export function resolveDesktopProfile(env: NodeJS.ProcessEnv): string

/**
 * Resolve the GS product's release version independently of the bundled Harness runtime.
 * @param env - Packaging environment.
 * @param runtimeVersion - Upstream runtime version.
 * @returns Product release version used by artifact names and update comparisons.
 */
export function resolveDesktopProductVersion(env: NodeJS.ProcessEnv, runtimeVersion: string): string

/**
 * Resolve whether the assisted Windows installer offers the all-users mode. The
 * upstream default keeps the custom per-user flow; branded builds that replace a
 * stock assisted-installer product need the stock mode-choice page so the new
 * package can cover an existing all-users installation.
 * @param env - Packaging environment.
 * @returns True when the assisted installer may elevate to an all-users install.
 */
export function resolveDesktopNsisAllowAllUsers(env: NodeJS.ProcessEnv): boolean

/**
 * Resolve whether the Windows installer prompts to remove a legacy installation that
 * shares this appId (the dsh-desktop 2.x product line). The NSIS include reads the
 * same variable at compile time; this resolver only validates the value early.
 * @param env - Packaging environment.
 * @returns True when the installer offers legacy uninstall before setup.
 */
export function resolveDesktopLegacyUninstallPrompt(env: NodeJS.ProcessEnv): boolean

/**
 * Resolve the brand asset directory, defaulting to the upstream resources directory.
 * @param env - Packaging environment.
 * @param baseDir - Directory that a relative override resolves from (the application root).
 * @returns Absolute brand directory, or undefined for the upstream default.
 */
export function resolveDesktopBrandDir(env: NodeJS.ProcessEnv, baseDir: string): string | undefined

/**
 * Resolve the npm registry used to materialize the bundled runtime and its external dependencies.
 * @param env - Packaging environment.
 * @returns Registry origin; the public registry unless a local mirror is configured.
 */
export function resolveNpmRegistry(env: NodeJS.ProcessEnv): string

/**
 * Resolve and validate the public identity expected on a macOS release.
 * @param env - Packaging environment.
 * @returns Expected certificate qualifier and Team ID.
 */
export function resolveMacOSSigningEnvironment(env: NodeJS.ProcessEnv): MacOSSigningEnvironment

/**
 * Resolve one complete credential set accepted by Apple's notary service.
 * @param env - Packaging environment.
 * @returns Notary credentials without the submitted artifact path.
 */
export function resolveMacOSNotarizationEnvironment(env: NodeJS.ProcessEnv): MacOSNotarizationEnvironment
