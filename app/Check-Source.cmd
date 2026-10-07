@echo off
rem Compares the project folder with the record of the last install (in Program Files, where only an
rem administrator can change it). The checker is this folder's app\check-source.ps1, but only if it is exactly
rem the copy that record lists: read once, its SHA-256 checked, and run from those bytes.
rem The project folder goes in through an environment variable, so a folder name with quotes or apostrophes
rem can neither break the command nor add PowerShell of its own.
setlocal
set "MDV_PROJECT=%~dp0.."
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$env:PSModulePath = $PSHOME + '\Modules'; $r = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'MarkdownViewerWebView2\source-manifest.txt'; if (-not (Test-Path -LiteralPath $r)) { Write-Host 'No record from an install yet - run Install.cmd first.'; exit 2 }; $want = Get-Content -LiteralPath $r -Encoding UTF8 | Where-Object { $_.EndsWith([string][char]9 + 'app\check-source.ps1') } | Select-Object -First 1; $b = [IO.File]::ReadAllBytes((Join-Path $env:MDV_PROJECT 'app\check-source.ps1')); if (-not $want -or ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)) -replace '-', '') -ne $want.Substring(0, 64)) { Write-Host 'app\check-source.ps1 is not the copy recorded at the last install, so it was not run. Look at its changes (git diff app\check-source.ps1).'; exit 3 }; & ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF))) -Root $env:MDV_PROJECT -Record $r"
pause
endlocal