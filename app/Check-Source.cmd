@echo off
rem Runs the checker installed in Program Files (only an administrator can change it), not the copy in this
rem project folder. Program Files is looked up by Windows itself, not taken from an environment variable.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$env:PSModulePath = $PSHOME + '\Modules'; $c = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'MarkdownViewerWebView2\check-source.ps1'; if (-not (Test-Path -LiteralPath $c)) { Write-Host 'The checker is not installed yet - run Install.cmd first.'; exit 2 }; & $c -Root '%~dp0..'; exit $LASTEXITCODE"
pause
