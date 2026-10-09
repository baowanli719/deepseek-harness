@echo off
setlocal DisableDelayedExpansion
set "signTool=%DSH_DESKTOP_WINDOWS_SIGNTOOL%"
set "certificateFile=%DSH_DESKTOP_WINDOWS_CER_FILE%"
set "tokenPin=%DSH_DESKTOP_WINDOWS_TOKEN_PIN%"
set "keyContainer=%DSH_DESKTOP_WINDOWS_KEY_CONTAINER%"
set "pfxFile=%DSH_DESKTOP_WINDOWS_PFX_FILE%"
set "pfxPassword=%DSH_DESKTOP_WINDOWS_PFX_PASSWORD%"
set "targetFile=%DSH_DESKTOP_WINDOWS_SIGN_TARGET%"
set "appendSignature="
if "%DSH_DESKTOP_WINDOWS_SIGN_APPEND%"=="1" set "appendSignature=/as"
set "DSH_DESKTOP_WINDOWS_SIGNTOOL="
set "DSH_DESKTOP_WINDOWS_CER_FILE="
set "DSH_DESKTOP_WINDOWS_TOKEN_PIN="
set "DSH_DESKTOP_WINDOWS_KEY_CONTAINER="
set "DSH_DESKTOP_WINDOWS_PFX_FILE="
set "DSH_DESKTOP_WINDOWS_PFX_PASSWORD="
set "DSH_DESKTOP_WINDOWS_SIGN_TARGET="
set "DSH_DESKTOP_WINDOWS_SIGN_APPEND="
if not "%pfxFile%"=="" goto pfx
set "signTool=" & set "certificateFile=" & set "tokenPin=" & set "keyContainer=" & set "pfxFile=" & set "pfxPassword=" & set "targetFile=" & set "appendSignature=" & "%signTool%" sign /v /fd sha256 /f "%certificateFile%" /kc "[{{%tokenPin%}}]=%keyContainer%" /csp "eToken Base Cryptographic Provider" %appendSignature% "%targetFile%"
goto finished
:pfx
set "signTool=" & set "certificateFile=" & set "tokenPin=" & set "keyContainer=" & set "pfxFile=" & set "pfxPassword=" & set "targetFile=" & set "appendSignature=" & "%signTool%" sign /v /fd sha256 /f "%pfxFile%" /p "%pfxPassword%" %appendSignature% "%targetFile%"
:finished
exit /b %errorlevel%
