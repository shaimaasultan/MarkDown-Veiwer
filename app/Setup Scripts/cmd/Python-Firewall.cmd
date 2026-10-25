@echo off
setlocal
choice /c CRM /m "Choose: Create or replace rules, Check rules, or Remove rules"
if errorlevel 3 goto ChooseRemove
if errorlevel 2 goto ChooseCheck
if errorlevel 1 goto ChooseCreate
exit /b 2
:ChooseCreate
set "MDV_ACTION=Create"
goto Launch
:ChooseCheck
set "MDV_ACTION=Check"
goto Launch
:ChooseRemove
set "MDV_ACTION=Remove"
:Launch
for %%I in ("%~dp0..\..\..") do set "MDV_PROJECT=%%~fI"

rem Verify the source helper against the administrator-protected install record, then pass those exact bytes
rem to the elevated process as an encoded command. No helper file is reopened after the UAC prompt.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$env:PSModulePath = $PSHOME + '\Modules'; $ErrorActionPreference = 'Stop'; try { $root = [IO.Path]::GetFullPath($env:MDV_PROJECT); $record = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'ReadSafeViewer\source-manifest.txt'; if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { $record = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'MarkdownViewerWebView2\source-manifest.txt' }; if (-not (Test-Path -LiteralPath $record -PathType Leaf)) { throw 'No trusted project record. Install this project once, then try again.' }; $helperRel = 'app\Setup Scripts\python-firewall.ps1'; $launcherRel = 'app\Setup Scripts\cmd\Python-Firewall.cmd'; $lines = [IO.File]::ReadAllLines($record); foreach ($rel in @($helperRel, $launcherRel)) { $line = $lines | Where-Object { $_.EndsWith([string][char]9 + $rel) } | Select-Object -First 1; if (-not $line) { throw ($rel + ' is not in the trusted install record. Reinstall this project before using this tool.') }; $file = Join-Path $root $rel; $bytes = [IO.File]::ReadAllBytes($file); $sha = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)) -replace '-', ''; if ($sha -ne $line.Substring(0,64)) { throw ($rel + ' differs from the last installed project record; refusing administrator execution.') }; if ($rel -eq $helperRel) { $source = $bytes } }; $mode = switch ($env:MDV_ACTION) { 'Create' { 'Create' } 'Check' { 'Check' } 'Remove' { 'Remove' } default { throw 'Invalid action.' } }; $sourceText = [Text.Encoding]::UTF8.GetString($source); $elevatedCode = '$env:MDV_PYTHON_FIREWALL_MODE=' + [char]39 + $mode + [char]39 + ';' + $sourceText; $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($elevatedCode)); if ($encoded.Length -gt 30000) { throw 'The verified helper is too large for a safe Windows command line.' }; $windows = [Environment]::GetFolderPath('Windows'); $powershell = Join-Path $windows 'System32\WindowsPowerShell\v1.0\powershell.exe'; $sig = Get-AuthenticodeSignature -LiteralPath $powershell; if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation,') { throw 'The Windows PowerShell executable does not have a valid Microsoft signature.' }; $psi = New-Object Diagnostics.ProcessStartInfo; $psi.FileName = $powershell; $psi.Arguments = '-NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + $encoded; $psi.Verb = 'runas'; $psi.UseShellExecute = $true; $psi.WindowStyle = 'Normal'; $p = [Diagnostics.Process]::Start($psi); $p.WaitForExit(); if ($p.ExitCode -ne 0) { Write-Host ('The elevated Python firewall action returned exit code ' + $p.ExitCode) -ForegroundColor Red }; exit $p.ExitCode } catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }"
set "MDV_RESULT=%errorlevel%"
if not "%MDV_RESULT%"=="0" pause
exit /b %MDV_RESULT%
