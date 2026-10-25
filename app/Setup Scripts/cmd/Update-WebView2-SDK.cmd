@echo off
rem Shows the plan for updating the three WebView2 SDK DLLs from nuget.org, then asks before downloading and replacing
rem anything. It never builds, signs or installs - run Install.cmd afterwards.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\update-sdk.ps1" -Apply %*
pause
