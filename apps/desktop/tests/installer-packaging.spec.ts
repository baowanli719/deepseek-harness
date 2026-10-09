import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Arch, Platform } from 'electron-builder'
import { Packager } from 'app-builder-lib'
import { describe, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn(async () => undefined) }))
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return { ...original, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) }
})

describe('installer preparation preserves application dependencies', () => {
  it.each(['win32', 'darwin'] as const)('rejects a missing production policy before signing on %s', async (platform) => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    expect(() => createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://test.example.com',
    }, platform, 'x64')).toThrow('DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN')
  })
  it.each(['win32', 'darwin'] as const)('keeps electron-builder responsible for node_modules on %s', async (platform) => {
    execute.mockClear()
    const env = {
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: platform,
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: platform === 'win32' ? '1' : '0',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
      DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com', DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
    }
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    try {
      const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
      const config = createElectronBuilderConfig(env, platform, 'x64')
      const aboutIcon = config.extraResources.find(resource => resource.to === 'icon.png')
      expect(aboutIcon).toBeDefined()
      expect(readFileSync(aboutIcon!.from)).toEqual(readFileSync(new URL('../resources/icon-windows.png', import.meta.url)))
      // Only the Windows package carries the tray bitmaps; macOS keeps the Dock.
      const trayIcon = config.extraResources.find(resource => resource.to === 'tray.ico')
      if (platform === 'win32') {
        expect(readFileSync(trayIcon!.from)).toEqual(readFileSync(new URL('../resources/tray-windows.ico', import.meta.url)))
      } else {
        expect(trayIcon).toBeUndefined()
      }
      const packager = new Packager({ projectDir: tmpdir() })
      // A foreign source-build target avoids rebuilding modules; the real dependency ownership decision still runs.
      Object.defineProperties(packager, {
        config: { value: { beforeBuild: config.beforeBuild, buildDependenciesFromSource: true } },
        framework: { value: { isNpmRebuildRequired: true, version: '42.0.0' } },
        appInfo: { value: { type: 'module' } },
      })
      vi.spyOn(packager, 'getWorkspaceRoot').mockResolvedValue(tmpdir())
      await packager.installAppDependencies(process.platform === 'win32' ? Platform.LINUX : Platform.WINDOWS, Arch.x64)
      expect(packager.areNodeModulesHandledExternally).toBe(false)
      expect(execute).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    } finally {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    }
  })

  it('names unsigned Windows artifacts so they cannot pass for release builds', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(config.artifactName).toBe('deepseek-harness-${version}-${os}-${arch}-unsigned.${ext}')
  })

  it('packages every preload entry point the shell loads', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const sourceDirectory = new URL('../src/', import.meta.url)
    const referenced = new Set<string>()
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      for (const match of readFileSync(new URL(entry.name, sourceDirectory), 'utf8').matchAll(/preload-[a-z-]+\.cjs/gu)) referenced.add(match[0])
    }
    expect(referenced.size).toBeGreaterThan(0)
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://harness-test.deepseek.com',
      DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
      DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
      APPLE_KEYCHAIN_PROFILE: 'installer-test',
    }, 'darwin', 'arm64')
    const packaged = new Set(config.files.filter((entry): entry is string => typeof entry === 'string'))
    for (const name of referenced) expect(packaged.has(`lib/${name}`)).toBe(true)
  })
})

describe('branded product identity overrides', () => {
  it('extends the GS release family while keeping the bundled Harness runtime version separate', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const { resolveDesktopProductVersion } = await import('../scripts/desktop-release-environment.mjs')
    const version = '2.2.0-test.20261003.1'
    const config = createElectronBuilderConfig({ DSH_DESKTOP_APP_ID: 'com.enterprise.officeagent',
      DSH_DESKTOP_PROFILE: 'gs-desktop', DSH_DESKTOP_BUILD_VERSION: version, DSH_DESKTOP_UNSIGNED: '1' }, 'win32', 'x64')
    expect(config.extraMetadata.version).toBe(version)
    expect(resolveDesktopProductVersion({}, '0.2.0-rc.2')).toBe('0.2.0-rc.2')
    expect(resolveDesktopProductVersion({ DSH_DESKTOP_PROFILE: 'gs-desktop' }, '0.2.0-rc.2')).toBe('2.2.0')
  })
  it('packages the gs-worker identity from environment overrides', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const config = createElectronBuilderConfig({
      DSH_DESKTOP_APP_ID: 'com.enterprise.officeagent',
      DSH_DESKTOP_PRODUCT_NAME: 'gs-worker',
      DSH_DESKTOP_ARTIFACT_BASENAME: 'gs-worker',
      DSH_DESKTOP_BRAND_DIR: 'brand/gs',
      DSH_DESKTOP_PROFILE: 'gs-desktop',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }, 'win32', 'x64')
    expect(config.productName).toBe('gs-worker')
    expect(config.appId).toBe('com.enterprise.officeagent')
    expect(config.artifactName).toBe('gs-worker-${version}-${os}-${arch}-unsigned.${ext}')
    expect(config.extraMetadata.dshDesktopProfile).toBe('gs-desktop')
    expect(config.extraMetadata.dshMandatoryUpdatePolicy).toBeUndefined()
    expect(config.publish).toBeNull()
    expect(config.extraMetadata.author).toEqual({ name: '国盛办公AI' })
    expect(config.extraMetadata.description).toBe('国盛办公AI桌面客户端')
    expect(config.extraMetadata.version).toBe('2.2.0')
    expect(config.files).toContain('lib/gs-login/**/*')
    expect(config.files).toContain('lib/preload-gs-login.cjs')
    expect(config.files).toContain('renderer/**/*')
    const brandDir = new URL('../brand/gs/', import.meta.url)
    expect(config.win.icon).toBe(fileURLToPath(new URL('icon-windows.ico', brandDir)))
    expect(config.nsis.installerIcon).toBe(config.win.icon)
    expect(config.nsis.uninstallerIcon).toBe(config.win.icon)
    const aboutIcon = config.extraResources.find(resource => resource.to === 'icon.png')
    expect(readFileSync(aboutIcon!.from)).toEqual(readFileSync(new URL('icon-windows.png', brandDir)))
    const trayIcon = config.extraResources.find(resource => resource.to === 'tray.ico')
    expect(readFileSync(trayIcon!.from)).toEqual(readFileSync(new URL('tray-windows.ico', brandDir)))
  })

  it('rejects invalid product overrides before packaging starts', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const base = {
      DSH_DESKTOP_APP_ID: 'com.example.installer',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
      DSH_DESKTOP_TARGET_PLATFORM: 'win32',
      DSH_DESKTOP_TARGET_ARCH: 'x64',
      DSH_DESKTOP_UNSIGNED: '1',
    }
    expect(() => createElectronBuilderConfig({ ...base, DSH_DESKTOP_ARTIFACT_BASENAME: 'GS Worker' }, 'win32', 'x64'))
      .toThrow('DSH_DESKTOP_ARTIFACT_BASENAME')
    expect(() => createElectronBuilderConfig({ ...base, DSH_DESKTOP_PROFILE: 'bad/profile' }, 'win32', 'x64'))
      .toThrow('DSH_DESKTOP_PROFILE')
    expect(() => createElectronBuilderConfig({ ...base, DSH_DESKTOP_BRAND_DIR: 'brand/missing' }, 'win32', 'x64'))
      .toThrow('DSH_DESKTOP_BRAND_DIR')
  })
})

describe('NSIS install-mode override', () => {
  const baseEnv = {
    DSH_DESKTOP_APP_ID: 'com.example.installer',
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    DSH_DESKTOP_TARGET_PLATFORM: 'win32',
    DSH_DESKTOP_TARGET_ARCH: 'x64',
    DSH_DESKTOP_UNSIGNED: '1',
  }

  it('keeps the custom per-user installer by default and allows all-users under the override', async () => {
    const { createElectronBuilderConfig } = await import('../scripts/electron-builder-config.mjs')
    const upstream = createElectronBuilderConfig(baseEnv, 'win32', 'x64')
    expect(upstream.nsis.oneClick).toBe(false)
    expect(upstream.nsis.perMachine).toBe(false)
    expect(upstream.nsis.allowElevation).toBe(false)
    expect(upstream.nsis.allowToChangeInstallationDirectory).toBe(false)
    const assisted = createElectronBuilderConfig({ ...baseEnv, DSH_DESKTOP_NSIS_ALLOW_ALL_USERS: '1' }, 'win32', 'x64')
    expect(assisted.nsis.oneClick).toBe(false)
    expect(assisted.nsis.perMachine).toBe(false)
    expect(assisted.nsis.allowElevation).toBe(true)
    expect(assisted.nsis.allowToChangeInstallationDirectory).toBe(true)
    expect(() => createElectronBuilderConfig({ ...baseEnv, DSH_DESKTOP_NSIS_ALLOW_ALL_USERS: 'yes' }, 'win32', 'x64'))
      .toThrow('DSH_DESKTOP_NSIS_ALLOW_ALL_USERS')
  })

  it('gates the custom per-user NSIS guards on the same switch via generated defines', async () => {
    const { readFileSync: read } = await import('node:fs')
    const source = read(new URL('../scripts/installer.nsh', import.meta.url), 'utf8')
    // NSIS evaluates !if before environment expansion, so the switch must arrive as a define.
    expect(source).toContain('!include "${INSTALLER_BUILD_DIR}' + '\\' + 'brand-defines.nsh"')
    expect(source).toContain('!define /ifndef DSH_NSIS_ALLOW_ALL_USERS "0"')
    const guards = source.match(/!if "\$\{DSH_NSIS_ALLOW_ALL_USERS\}" != "1"/gu)
    expect(guards?.length).toBeGreaterThanOrEqual(2)
    expect(source).toContain('!macro customInstallMode')
    expect(source).toContain('!macro customInit')
    expect(source).toContain('!define MUI_CUSTOMFUNCTION_GUIINIT InstallerGuiInit')
    expect(source).toContain('!insertmacro MUI_PAGE_FINISH')
    expect(source).toContain('!undef MUI_PAGE_CUSTOMFUNCTION_PRE')
  })
})

describe('installer branding and legacy uninstall', () => {
  const installerSource = readFileSync(new URL('../scripts/installer.nsh', import.meta.url), 'utf8')
  const stringsSource = readFileSync(new URL('../installer/strings.nsh', import.meta.url), 'utf8')

  it('marks Harness installations and excludes them from both legacy uninstall scans', () => {
    expect(installerSource).toContain('WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DshRuntimeFamily "deepseek-harness"')
    for (const name of ['InstallerLegacyCheckRegisteredKey', 'InstallerLegacyScanEntries']) {
      const start = installerSource.indexOf(`!macro ${name}`)
      const macro = installerSource.slice(start, installerSource.indexOf('!macroend', start))
      expect(macro).toContain('"DshRuntimeFamily"')
      expect(macro.indexOf('${If} $R8 != "deepseek-harness"')).toBeLessThan(macro.indexOf('"DisplayVersion"'))
    }
  })

  it('resolves installer copy through the compile-time product name with the upstream default', () => {
    expect(installerSource).toContain('!define /ifndef DSH_INSTALLER_PRODUCT "DeepSeek Harness"')
    expect(stringsSource).not.toMatch(/LangString [A-Z_]+ .*DeepSeek Harness/u)
    expect(stringsSource).toContain('${DSH_INSTALLER_PRODUCT}')
  })

  it('checks every registry view for a legacy install and prompts before removing it', () => {
    // Direct lookup uses the real uninstall key (UUIDv5 of the appId), not the app settings key.
    expect(installerSource).toContain('!macro InstallerLegacyCheckRegisteredKey Hive Tag')
    expect(installerSource).toContain('"${UNINSTALL_REGISTRY_KEY}" "UninstallString"')
    expect(installerSource).not.toContain('"${INSTALL_REGISTRY_KEY}" "UninstallString"')
    // Enumeration fallback matches DisplayName by product-name prefix across all views.
    expect(installerSource).toContain('!macro InstallerLegacyScanEntries Hive Tag')
    expect(installerSource).toContain('EnumRegKey $R3 ${Hive} "${DSH_UNINSTALL_ROOT}" $R4')
    expect(installerSource).toContain('"DisplayName"')
    expect(installerSource).toContain('StrLen $R1 "${DSH_INSTALLER_PRODUCT}"')
    expect(installerSource).toContain('${If} $R2 == "${DSH_INSTALLER_PRODUCT}"')
    // HKCU, 64-bit HKLM, and the WOW6432Node view are each scanned.
    for (const tag of ['hkcu', 'hklm64', 'hklm32']) {
      expect(installerSource).toContain(`InstallerLegacyCheckRegisteredKey HK${tag === 'hkcu' ? 'CU' : 'LM'} ${tag}`)
      expect(installerSource).toContain(`InstallerLegacyScanEntries HK${tag === 'hkcu' ? 'CU' : 'LM'} ${tag}`)
    }
    expect(installerSource).toContain('SetRegView 64')
    expect(installerSource).toContain('SetRegView 32')
    expect(installerSource).toContain('!define /ifndef DSH_LEGACY_UNINSTALL_PROMPT "0"')
    expect(installerSource).toContain('!if "${DSH_LEGACY_UNINSTALL_PROMPT}" == "1"')
    // The legacy block precedes the per-user guards so a legacy all-users entry is removed first.
    const init = installerSource.slice(installerSource.indexOf('!macro customInit'), installerSource.indexOf('!macro customInstallMode'))
    expect(init.indexOf('InstallerLegacyCheckRegisteredKey HKCU'))
      .toBeLessThan(init.indexOf('; Branded builds enabling DSH_NSIS_ALLOW_ALL_USERS'))
    // Legacy identification is restricted to the dsh-desktop 2.x line.
    expect(installerSource).toContain('StrCpy $R8 $R7 2')
    expect(installerSource).toContain('${If} $R8 == "2."')
    // The prompt is cancellable and the uninstall is awaited and re-verified.
    expect(installerSource).toContain('MB_YESNO|MB_ICONQUESTION "$(INSTALLER_LEGACY_DETECTED)"')
    expect(installerSource).toContain('QuietUninstallString')
    expect(installerSource).toContain('Exec \'$R9\'')
    expect(installerSource).not.toContain('ExecWait \'$R9\'')
    expect(installerSource).toContain('StrCpy $R9 "$R6 /S"')
    expect(installerSource).toContain('${If} $R5 < 60')
    expect(installerSource).toContain('Sleep 500')
    expect(installerSource).toContain('legacy_wait_${Tag}:')
    expect(installerSource).toContain('"$(INSTALLER_LEGACY_FAILED)"')
    expect(stringsSource).toContain('LangString INSTALLER_LEGACY_DETECTED ${LANG_ENGLISH}')
    expect(stringsSource).toContain('LangString INSTALLER_LEGACY_DETECTED ${LANG_SIMPCHINESE}')
    expect(stringsSource).toContain('${DSH_INSTALLER_PRODUCT} $R7')
    expect(stringsSource).toContain('LangString INSTALLER_LEGACY_FAILED ${LANG_ENGLISH}')
    expect(stringsSource).toContain('LangString INSTALLER_LEGACY_FAILED ${LANG_SIMPCHINESE}')
  })

  it('explains leftover files instead of auto-cleaning a legacy directory', () => {
    // Legacy InstallLocation can be empty, so residue cleanup stays manual and the copy says so.
    expect(stringsSource).toMatch(/INSTALLER_PATH_OWNERSHIP.*leftover files/u)
    expect(stringsSource).toMatch(/INSTALLER_PATH_OWNERSHIP.*残留文件/u)
    expect(installerSource).toContain('never auto-cleaned')
  })

  it('selects branded installer artwork only as a complete set', async () => {
    const { readFileSync: read } = await import('node:fs')
    const script = read(new URL('../scripts/prepare-windows-installer.ps1', import.meta.url), 'utf8')
    expect(script).toContain('DSH_DESKTOP_BRAND_DIR')
    expect(script).toContain('Branded installer assets are incomplete')
    expect(script).toContain('brand-defines.nsh')
    expect(script).toContain('DSH_DESKTOP_LEGACY_UNINSTALL_PROMPT')
    for (const asset of ['brand.png', 'brand-2x.png', 'brand-dark.png', 'brand-dark-2x.png', 'uninstaller-sidebar.png']) {
      expect(read(new URL(`../brand/gs/installer/${asset}`, import.meta.url)).length).toBeGreaterThan(0)
    }
  })
})
