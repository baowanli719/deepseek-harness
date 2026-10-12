!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define INSTALLER_SOURCE_DIR "${__FILEDIR__}\..\installer"
!define /ifndef INSTALLER_BUILD_DIR "${__FILEDIR__}\..\.desktop-build\targets\win-x64\installer-ui"

; Branding and legacy-product switches are baked at packaging time by
; prepare-windows-installer.ps1 into brand-defines.nsh; NSIS !if cannot read
; environment variables, so the generated file is the channel. The defaults below
; keep the upstream DeepSeek Harness behavior when no brand was configured.
!if /FILEEXISTS "${INSTALLER_BUILD_DIR}\brand-defines.nsh"
  !include "${INSTALLER_BUILD_DIR}\brand-defines.nsh"
!endif
!define /ifndef DSH_INSTALLER_PRODUCT "DeepSeek Harness"
!define /ifndef DSH_NSIS_ALLOW_ALL_USERS "0"
!define /ifndef DSH_LEGACY_UNINSTALL_PROMPT "0"

; Detect and remove a legacy dsh-desktop gs-worker installation. electron-builder
; names the uninstall entry UUIDv5(appId), so old and new products share one key —
; but older packages may differ, so detection also scans every Uninstall subkey for a
; DisplayName prefixed by the product name. The old desktop product uses 2.x.
; Compiled in only for branded builds that enable
; DSH_DESKTOP_LEGACY_UNINSTALL_PROMPT.
!define DSH_UNINSTALL_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"

!macro InstallerLegacyRemoveEntry Hive EntryKey Tag
  MessageBox MB_YESNO|MB_ICONQUESTION "$(INSTALLER_LEGACY_DETECTED)" /SD IDYES IDYES legacy_yes_${Tag}
  SetErrorLevel 2
  Quit
  legacy_yes_${Tag}:
  ReadRegStr $R9 ${Hive} "${EntryKey}" "QuietUninstallString"
  ${If} $R9 == ""
    ReadRegStr $R6 ${Hive} "${EntryKey}" "UninstallString"
    StrCpy $R9 "$R6 /S"
  ${EndIf}
  ClearErrors
  Exec '$R9'
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_LEGACY_FAILED)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ; Exec starts the quiet uninstaller asynchronously. The stock uninstaller may
  ; hand deletion to a detached helper, so wait for its registry entry, not its PID.
  StrCpy $R5 0
  legacy_wait_${Tag}:
  ReadRegStr $R6 ${Hive} "${EntryKey}" "UninstallString"
  ${If} $R6 == ""
    Goto legacy_done_${Tag}
  ${EndIf}
  IntOp $R5 $R5 + 1
  ${If} $R5 < 60
    Sleep 500
    Goto legacy_wait_${Tag}
  ${EndIf}
  legacy_done_${Tag}:
  ${If} $R6 != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_LEGACY_FAILED)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ; A legacy directory left behind after uninstall is never auto-cleaned: the legacy
  ; entry's InstallLocation can be empty, so the only hint is the UninstallString's
  ; parent, and deleting files under a registry-derived path could erase user data
  ; kept beside the old app. INSTALLER_PATH_OWNERSHIP tells the user instead.
!macroend

!macro InstallerLegacyCheckRegisteredKey Hive Tag
  ReadRegStr $R6 ${Hive} "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R6 != ""
    ReadRegStr $R8 ${Hive} "${UNINSTALL_REGISTRY_KEY}" "DshRuntimeFamily"
    ${If} $R8 != "deepseek-harness"
      ReadRegStr $R7 ${Hive} "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
      StrCpy $R8 $R7 2
      ${If} $R8 == "2."
        !insertmacro InstallerLegacyRemoveEntry ${Hive} "${UNINSTALL_REGISTRY_KEY}" "${Tag}-direct"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro InstallerLegacyScanEntries Hive Tag
  StrCpy $R4 0
  legacy_scan_${Tag}:
  EnumRegKey $R3 ${Hive} "${DSH_UNINSTALL_ROOT}" $R4
  ${If} $R3 == ""
    Goto legacy_scandone_${Tag}
  ${EndIf}
  ReadRegStr $R2 ${Hive} "${DSH_UNINSTALL_ROOT}\$R3" "DisplayName"
  StrLen $R1 "${DSH_INSTALLER_PRODUCT}"
  StrCpy $R2 $R2 $R1
  ${If} $R2 == "${DSH_INSTALLER_PRODUCT}"
    ReadRegStr $R8 ${Hive} "${DSH_UNINSTALL_ROOT}\$R3" "DshRuntimeFamily"
    ${If} $R8 != "deepseek-harness"
      ReadRegStr $R7 ${Hive} "${DSH_UNINSTALL_ROOT}\$R3" "DisplayVersion"
      StrCpy $R8 $R7 2
      ${If} $R8 == "2."
        !insertmacro InstallerLegacyRemoveEntry ${Hive} "${DSH_UNINSTALL_ROOT}\$R3" "${Tag}-scan"
        ; A removed entry shifts every later index; restart the scan.
        Goto legacy_scan_${Tag}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  IntOp $R4 $R4 + 1
  Goto legacy_scan_${Tag}
  legacy_scandone_${Tag}:
!macroend

ManifestDPIAware true
!ifndef BUILD_UNINSTALLER
  !if "${DSH_NSIS_ALLOW_ALL_USERS}" != "1"
    !define MUI_CUSTOMFUNCTION_GUIINIT InstallerGuiInit
  !endif
!endif

!macro customHeader
  !define /ifndef INSTALLER_STRINGS_FILE "${INSTALLER_SOURCE_DIR}\strings.nsh"
  !include "${INSTALLER_STRINGS_FILE}"
  !ifdef BUILD_UNINSTALLER
    BrandingText " "
    SetFont "Segoe UI" 9
    !ifdef LANG_SIMPCHINESE
      SetFont /LANG=${LANG_SIMPCHINESE} "Microsoft YaHei UI" 9
    !endif
    !include "${INSTALLER_SOURCE_DIR}\uninstall.nsh"
  !endif
  !ifndef BUILD_UNINSTALLER
    !include "${INSTALLER_SOURCE_DIR}\theme.nsh"
    !if "${DSH_NSIS_ALLOW_ALL_USERS}" == "1"
      !include "${INSTALLER_SOURCE_DIR}\path.nsh"
    !else
      !include "${INSTALLER_SOURCE_DIR}\pages.nsh"
    !endif
    !include "${INSTALLER_SOURCE_DIR}\lifecycle.nsh"
    Function InstallerCheckAppRunning
      !insertmacro customCheckAppRunning
    FunctionEnd
  !endif
!macroend

!macro customInit
  ; Legacy removal runs before every mode guard: a legacy all-users entry must not trip
  ; the per-user conflict check, and the mode-choice page only appears after cleanup.
  !if "${DSH_LEGACY_UNINSTALL_PROMPT}" == "1"
    ; The installer is 32-bit: HKLM reads default to WOW6432Node, so the 64-bit view
    ; needs SetRegView 64; HKCU is never redirected. This build targets x64, whose
    ; ambient view is 64, so restore it after each 32-bit scan.
    !insertmacro InstallerLegacyCheckRegisteredKey HKCU hkcu
    SetRegView 64
    !insertmacro InstallerLegacyCheckRegisteredKey HKLM hklm64
    SetRegView 32
    !insertmacro InstallerLegacyCheckRegisteredKey HKLM hklm32
    SetRegView 64
    !insertmacro InstallerLegacyScanEntries HKCU hkcu
    SetRegView 64
    !insertmacro InstallerLegacyScanEntries HKLM hklm64
    SetRegView 32
    !insertmacro InstallerLegacyScanEntries HKLM hklm32
    SetRegView 64
  !endif
  !if "${DSH_NSIS_ALLOW_ALL_USERS}" == "1"
    ; initMultiUser ran before the legacy uninstall. Re-read the remaining
    ; installation records so the native mode page uses current registrations.
    !insertmacro initMultiUser
  !endif
  ; Branded builds enabling DSH_NSIS_ALLOW_ALL_USERS keep the stock assisted mode-choice
  ; page: the per-user guards below would reject the all-users branch.
  !if "${DSH_NSIS_ALLOW_ALL_USERS}" != "1"
    ${If} ${isForAllUsers}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_PER_USER)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_PER_USER)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    !insertmacro setInstallModePerUser
    StrCpy $hasPerMachineInstallation 0
    StrCpy $hasPerUserInstallation 1
  !endif
  StrCpy $InstallerPath $INSTDIR
  StrCpy $InstallerTheme "auto"
  ${GetParameters} $0
  ${GetOptions} $0 "/THEME=" $1
  ${IfNot} ${Errors}
    ${If} $1 == "light"
    ${OrIf} $1 == "dark"
    ${OrIf} $1 == "auto"
      StrCpy $InstallerTheme $1
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_THEME_ERROR)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
  Call InstallerResolveTheme
  InitPluginsDir
  File "/oname=$PLUGINSDIR\brand.bmp" "${INSTALLER_BUILD_DIR}\brand.bmp"
  File "/oname=$PLUGINSDIR\brand-2x.bmp" "${INSTALLER_BUILD_DIR}\brand-2x.bmp"
  File "/oname=$PLUGINSDIR\brand-dark.bmp" "${INSTALLER_BUILD_DIR}\brand-dark.bmp"
  File "/oname=$PLUGINSDIR\brand-dark-2x.bmp" "${INSTALLER_BUILD_DIR}\brand-dark-2x.bmp"
  File "/oname=$PLUGINSDIR\window-frame.dll" "${INSTALLER_BUILD_DIR}\window-frame.dll"
  !if "${DSH_NSIS_ALLOW_ALL_USERS}" != "1"
    Call InstallerCheckAppRunning
    ${If} ${Silent}
      Call InstallerPreflight
      ${If} $InstallerError != ""
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro customInstallMode
  !if "${DSH_NSIS_ALLOW_ALL_USERS}" != "1"
    ; Preserve the directory selected on the custom welcome page.
    StrCpy $installMode CurrentUser
    SetShellVarContext current
    Abort
  !endif
!macroend

!macro customWelcomePage
  !if "${DSH_NSIS_ALLOW_ALL_USERS}" != "1"
    Page custom InstallerWelcome InstallerWelcomeLeave
  !endif
!macroend

!macro customUnInstall
  Call un.CleanData
!macroend

!macro customPageAfterChangeDir
  !if "${DSH_NSIS_ALLOW_ALL_USERS}" == "1"
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE InstallerBeforeInstall
  !if "${DSH_NSIS_ALLOW_ALL_USERS}" != "1"
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW InstallerProgressShow
  !endif
!macroend

!macro customFinishPage
  !if "${DSH_NSIS_ALLOW_ALL_USERS}" != "1"
    Page custom InstallerFinish InstallerFinishLeave
  !else
    Function InstallerNativeStartApp
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION InstallerNativeStartApp
    !insertmacro MUI_PAGE_FINISH
  !endif
!macroend

; Installation work publishes stage changes without disturbing the NSIS caller.
!macro InstallerPublishStage Stage
  ; Extraction owns the stack and error flag across these callbacks.
  Push $0
  StrCpy $0 0
  ${If} ${Errors}
    StrCpy $0 1
  ${EndIf}
  System::Store /NOUNLOAD "S"
  System::Call /NOUNLOAD 'user32::SetPropW(p $HWNDPARENT, w "HarnessInstaller.Stage", p ${Stage})'
  System::Store "L"
  ${If} $0 == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $0
!macroend

!macro customInstallerExtract Archive
  !insertmacro InstallerPublishStage 1
  System::Store /NOUNLOAD "S"
  System::Call /NOUNLOAD '$PLUGINSDIR\window-frame.dll::InstallerExtract(p $HWNDPARENT, w "$PLUGINSDIR\dsh-7za.exe", w "${Archive}", w "$INSTDIR", w "$PLUGINSDIR\extract.log") i.s ?c'
  System::Store "L"
  Pop $R0
  ; The failure report owns 7-Zip's UTF-8 output; the details view only needs the result code.
  StrCpy $R1 "$R0"
!macroend

; The report outlives $PLUGINSDIR so a user can send it; silent installs keep only the file. The updater cache
; directory is never an installation target and leaves with the application on uninstall.
; The directory smoke fixture predefines DSH_INSTALLER_LOG_DIR to keep reports inside its scratch tree.
!ifndef DSH_INSTALLER_LOG_DIR
  !define DSH_INSTALLER_LOG_DIR "$LOCALAPPDATA\${DSH_UPDATER_CACHE_NAME}\installer-logs"
!endif

!macro customInstallerExtractFailed Archive
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  ; GetTime yields zero-padded day, month, year, weekday, hour, minute, second.
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  StrCpy $0 "${DSH_INSTALLER_LOG_DIR}\extract-failure-$2$1$0-$4$5$6.log"
  StrCpy $1 1
  ${If} ${Silent}
    StrCpy $1 0
  ${EndIf}
  System::Call '$PLUGINSDIR\window-frame.dll::InstallerReportExtractFailure(p $HWNDPARENT, i R0, w "${Archive}", w "$dshNewDirectory", w "$PLUGINSDIR\extract.log", w r0, i r1, w "$(^SetupCaption)", w "$(INSTALLER_EXTRACT_FAILED)", w "$(INSTALLER_EXTRACT_HINT)", w "$(INSTALLER_EXTRACT_COPY)", w "$(INSTALLER_EXTRACT_EXPAND)", w "$(INSTALLER_EXTRACT_COLLAPSE)", w "$(INSTALLER_EXTRACT_SAVED)", w "$(INSTALLER_EXTRACT_UNSAVED)", w "$(INSTALLER_EXTRACT_COPIED)") i.r2 ?c'
  ${If} $2 == 1
    DetailPrint $0
  ${EndIf}
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !if "${DSH_NSIS_ALLOW_ALL_USERS}" == "1"
      ${If} ${Silent}
        StrCpy $InstallerPath $INSTDIR
        Call InstallerPreflight
        ${If} $InstallerError != ""
          DetailPrint $InstallerError
          SetErrorLevel 2
          Quit
        ${EndIf}
      ${EndIf}
    !endif
  !endif
  !ifdef BUILD_UNINSTALLER
    InitPluginsDir
    File "/oname=$PLUGINSDIR\window-frame.dll" "${INSTALLER_BUILD_DIR}\window-frame.dll"
  !endif
  System::Call '$PLUGINSDIR\window-frame.dll::InstallerFindProcess(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}") i.R0 ?c'
  ${If} $R0 == 0
    ${If} ${isUpdated}
      StrCpy $R1 0
      ${DoWhile} $R0 == 0
        Sleep 250
        System::Call '$PLUGINSDIR\window-frame.dll::InstallerFindProcess(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}") i.R0 ?c'
        IntOp $R1 $R1 + 1
        ${If} $R1 >= 40
          ${ExitDo}
        ${EndIf}
      ${Loop}
    ${EndIf}
    ${If} $R0 == 0
      MessageBox MB_OK|MB_ICONINFORMATION "$(INSTALLER_RUNNING)" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
  ${If} $R0 < 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_UI_ERROR)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
  !include "${__FILEDIR__}\installer-directories.nsh"
!endif

!macro customInstall
  Push $0
  StrCpy $0 0
  ${If} ${Errors}
    StrCpy $0 1
  ${EndIf}
  !insertmacro InstallerPublishStage 4
  !insertmacro dshFinishDirectories
  ; Standard uninstall-entry metadata read by inventory tools; the upstream template records it only under its private key.
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DshRuntimeFamily "deepseek-harness"
  ${If} $0 == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $0
!macroend
