@echo off
rem Checks for newer WebView2 SDK DLLs and bundled libraries, and whether app\dist has picked up the
rem project's SDK DLLs. Only reports - nothing is downloaded or installed. This is the project's only update check:
rem the viewer itself never goes online.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\check-updates.ps1"
pause
