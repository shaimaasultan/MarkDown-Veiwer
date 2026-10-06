@echo off
rem Shows the plan for updating the bundled libraries, then asks before downloading and replacing anything.
rem It never builds, signs or installs - run Install.cmd afterwards (after testing a few documents).
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-libs.ps1" -Apply %*
pause
