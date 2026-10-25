@echo off
rem Checks for newer WebView2 SDK DLLs and bundled libraries, and whether app\dist has picked up the
rem project's SDK DLLs. Only reports - nothing is downloaded or installed. The app has a separate daily SDK-only check.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\check-updates.ps1"
pause
