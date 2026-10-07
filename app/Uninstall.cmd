@echo off
rem Uninstalls with the installed Uninstall.exe (a copy installed before 1.11: its uninstall.ps1).
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$env:PSModulePath = $PSHOME + '\Modules'; $d = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'MarkdownViewerWebView2'; $u = Join-Path $d 'Uninstall.exe'; if (Test-Path -LiteralPath $u) { $p = Start-Process -FilePath $u -ArgumentList '--uninstall' -PassThru -Wait; exit $p.ExitCode }; $s = Join-Path $d 'uninstall.ps1'; if (Test-Path -LiteralPath $s) { & $s; exit $LASTEXITCODE }; Write-Host 'Markdown Viewer (WebView2) is not installed - run Install.cmd first.'; exit 2"
pause
