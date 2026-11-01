@echo off
rem Forward all arguments to pd-chat inside WSL (distro from PD_WSL_DISTRO, default Ubuntu).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0pd-chat.ps1" %*
exit /b %ERRORLEVEL%
