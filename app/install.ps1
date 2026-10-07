# Installs Markdown Viewer (WebView2) on this PC:
#   checks the project folder against the record of the last install, records it again, builds and signs the
#   program as you (build.ps1), then installs it with the Setup that build made - the same steps as on any
#   other PC: one administrator prompt copies it to C:\Program Files\MarkdownViewerWebView2 (where no program
#   running as you can change its files or put a DLL next to them) and adds the firewall rules that block its
#   network traffic; then the .md / .markdown / .mdown / .mkd file association, Open with, Start menu entries
#   and the Settings > Apps entry are made for your own account. No script file is installed: Program Files
#   gets the program, Uninstall.exe and the project record (for Check-Source.cmd).
# Only Windows PowerShell's own modules, from its system folder: a look-alike command in the user's module
# folder (Documents) could otherwise run in place of the ones used here.
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$name = 'Markdown Viewer (WebView2)'
$key = 'MarkdownViewerWebView2'
$exeName = "$key.exe"
$dist = Join-Path $here 'dist'
# Program Files as Windows records it (not the ProgramFiles environment variable, which can be set per user).
$dest = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) $key
$exe = Join-Path $dest $exeName
# A question needs a console keyboard: in PowerShell ISE, or with input redirected, it would wait forever.
function Read-YesNo([string]$question) {
    if ([Console]::IsInputRedirected -or $Host.Name -ne 'ConsoleHost') {
        Write-Host 'This window cannot answer the question. Run Install.cmd by double-clicking it. Nothing was changed.' -ForegroundColor Yellow
        exit 1
    }
    (Read-Host "$question [Y/N]").Trim() -match '^(y|yes)$'
}

# Started normally, not as administrator: run as administrator, the build would sign with another account's
# certificate and the registrations could land in another account's profile. Only the copy to Program Files
# asks for administrator rights. (With User Account Control off there is no other way.)
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$uac = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).EnableLUA -ne 0
if ($elevated -and $uac) {
    Write-Host "Run Install.cmd normally (double-click it, not 'Run as administrator')."
    Write-Host 'Windows asks for administrator rights only for copying the program to Program Files.'
    exit 1
}

# Windows can't replace a running program: close open viewer windows first.
$running = @(Get-Process $key -ErrorAction SilentlyContinue)
if ($running.Count) {
    Write-Host "Closing $($running.Count) open $name window(s) to update the program; reopen your documents afterwards."
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

# Before building: has the project folder changed since the last install? The record of the last install sits
# in Program Files (only an administrator can change it). It is checked by the project's check-source.ps1, but
# only if that is exactly the checker the record lists (its SHA-256): read once, checked, and run from those
# bytes, so a changed checker never gets to report "no changes". Changes nobody meant to make should not get
# built and signed unnoticed; changes you made or pulled yourself just need a Y.
$projectRoot = Split-Path $here -Parent
$psExe = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
$checkRecorded = @(
    '$env:PSModulePath = $PSHOME + ''\Modules'''
    '$r = Join-Path ([Environment]::GetFolderPath(''ProgramFiles'')) ''MarkdownViewerWebView2\source-manifest.txt'''
    'if (-not (Test-Path -LiteralPath $r)) { exit 2 }'
    '$want = Get-Content -LiteralPath $r -Encoding UTF8 | Where-Object { $_.EndsWith([string][char]9 + ''app\check-source.ps1'') } | Select-Object -First 1'
    '$b = [IO.File]::ReadAllBytes((Join-Path $env:MDV_PROJECT ''app\check-source.ps1''))'
    'if (-not $want -or ([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)) -replace ''-'', '''') -ne $want.Substring(0, 64)) { exit 3 }'
    '& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b).TrimStart([char]0xFEFF))) -Root $env:MDV_PROJECT -Record $r -Quiet:($env:MDV_QUIET -eq ''1'')'
) -join '; '
function Invoke-RecordedChecker([switch]$Quiet) {
    $env:MDV_PROJECT = $projectRoot; $env:MDV_QUIET = if ($Quiet) { '1' } else { '0' }
    try { & $psExe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $checkRecorded | Out-Host; $LASTEXITCODE }
    finally { Remove-Item Env:\MDV_PROJECT, Env:\MDV_QUIET -ErrorAction SilentlyContinue }
}
switch (Invoke-RecordedChecker -Quiet) {
    0 { Write-Host 'Project folder unchanged since the last install.' }
    1 {
        Invoke-RecordedChecker | Out-Null
        if (-not (Read-YesNo 'Build and install these changes?')) { Write-Host 'Nothing was built or installed.'; exit 1 }
    }
    2 { Write-Host 'No record from an earlier install yet; this install makes one.' }
    3 {
        Write-Host 'check-source.ps1 is not the one recorded at the last install, so the folder could not be checked with it.' -ForegroundColor Yellow
        Write-Host 'Look at its changes (git diff app\check-source.ps1) before going on.'
        if (-not (Read-YesNo 'Build and install anyway?')) { Write-Host 'Nothing was built or installed.'; exit 1 }
    }
    default { Write-Host 'The project folder could not be compared with the last install (see above); this install makes a new record.' -ForegroundColor Yellow }
}

# Record the SHA-256 of every project file before the build. It goes into a Setup made for this PC only and
# from there into Program Files, next to the program, where only an administrator can change it.
New-Item -ItemType Directory -Force $dist | Out-Null
$recordFile = Join-Path $dist 'source-manifest.txt'
& (Join-Path $here 'check-source.ps1') -Write $recordFile
if ($LASTEXITCODE -ne 0) { Write-Host 'The project files could not be recorded; nothing was installed.'; exit 1 }
# Always rebuild so the installed copy matches the current sources.
& (Join-Path $here 'build.ps1') -Record $recordFile
# The sources must still be exactly as recorded: a change while building would mean the program was built
# from something other than what the record says.
& (Join-Path $here 'check-source.ps1') -Record $recordFile -Quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host 'The project files changed while the app was being built; nothing was installed.' -ForegroundColor Yellow
    Write-Host 'Run Install.cmd again once nothing is editing the project folder.'
    exit 1
}

# Install with the Setup just built (the same steps as on any other PC): one administrator prompt - for
# Windows PowerShell, which runs only Setup's copy step from its checked bytes - copies the files into Program
# Files and adds the firewall rules; then Setup registers the file types, Open with, Start menu and Settings >
# Apps for you. A new signing certificate, or open viewer windows, are asked about in a Yes/No box.
$version = (Get-Item (Join-Path $dist $exeName)).VersionInfo.ProductVersion
$localSetup = Join-Path $here "release\MarkdownViewer-Setup-$version-this-PC.exe"
Write-Host "Installing with $(Split-Path $localSetup -Leaf) (Windows asks for administrator rights for Windows PowerShell; 'Show more details' shows the command and Setup's SHA-256)..."
try {
    & $localSetup --install | ForEach-Object { Write-Host $_ }
    $installed = $LASTEXITCODE
} finally { try { [IO.File]::Delete($localSetup) } catch { } }
if ($installed -ne 0) { Write-Host 'Not installed (see above). The installed copy was left as it was.' -ForegroundColor Yellow; exit 1 }
Write-Host ""
Write-Host "Installed $name $version to $dest"
# The same build as one signed Setup file, for installing on other PCs (made by build.ps1).
$setupFile = Get-ChildItem -LiteralPath (Join-Path $here 'release') -Filter "MarkdownViewer-Setup-$version.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($setupFile) { Write-Host "For other PCs: $($setupFile.FullName) (one signed file; it installs Uninstall.exe next to the program)." }
# Update reminder, from the last Check-Updates.cmd result (the installer itself never goes online).
$updateState = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "$key\update-check.txt"
$checked = $null; $updatesFound = @()
if (Test-Path -LiteralPath $updateState) {
    foreach ($line in Get-Content -LiteralPath $updateState) {
        if ($line -like 'checked=*') { try { $checked = [datetime]::Parse($line.Substring(8)) } catch { } }
        elseif ($line -like 'update=*') { $updatesFound += $line.Substring(7) }
    }
}
if ($updatesFound.Count) {
    Write-Host "Updates were available at the last check ($($checked.ToString('yyyy-MM-dd'))): $($updatesFound -join '; ')" -ForegroundColor Yellow
    Write-Host 'See README > Updating the WebView2 SDK and libraries. Run Check-Updates.cmd again after updating.'
} elseif (-not $checked -or ((Get-Date) - $checked).TotalDays -gt 30) {
    Write-Host "Tip: run Check-Updates.cmd to see whether a newer WebView2 SDK or library version is out$(if ($checked) { " (last check $($checked.ToString('yyyy-MM-dd')))" } else { ' (never checked)' })."
}
$sig = Get-AuthenticodeSignature $exe
Write-Host "Signed by $($sig.SignerCertificate.Subject) ($($sig.SignerCertificate.Thumbprint))."
if ($sig.Status -ne 'Valid') { Write-Host 'Optional: run Trust-Certificate.cmd so Windows also shows this signature as valid.' }
# Signatures carry no timestamp, so the viewer stops starting once the certificate expires. Warn a year ahead.
$left = [int][Math]::Floor(($sig.SignerCertificate.NotAfter - (Get-Date)).TotalDays)
if ($left -lt 365) {
    Write-Host "The signing certificate expires on $($sig.SignerCertificate.NotAfter.ToString('yyyy-MM-dd')) ($left days); after that the installed viewer refuses to start." -ForegroundColor Yellow
    Write-Host 'Within its last 30 days the build makes a new certificate: run Install.cmd then, answer Y to the certificate change,' -ForegroundColor Yellow
    Write-Host 'and run Trust-Certificate.cmd again.' -ForegroundColor Yellow
}