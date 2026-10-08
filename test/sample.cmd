@echo off
:: Sample batch file for the viewer's colours - shown, never run (it only prints and exits).
rem Variables, labels, strings and commands.
setlocal enabledelayedexpansion
set "NAME=world"
set /a COUNT=3
if not defined NAME goto :done
for %%i in (one two three) do echo %%i !COUNT! "%NAME%" %~dp0
echo Hello, %NAME% > nul 2>&1
:done
endlocal
exit /b 0
