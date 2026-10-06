@echo off
rem Checks nuget.org and the npm registry for newer versions of the WebView2 SDK and the bundled libraries.
rem Only reports - nothing is downloaded or installed. The viewer itself never goes online.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-updates.ps1"
pause
