# Installs Markdown Viewer (WebView2):
#   builds and signs it as you, then copies the program to C:\Program Files\MarkdownViewerWebView2 - the only
#   step that runs with administrator rights (one UAC prompt). There, no program running as you can change
#   the program's files or put a DLL next to them.
#   Start menu entries, Settings > Apps entry and the .md / .markdown / .mdown / .mkd file association are
#   made for your own account. A copy from earlier versions in %LOCALAPPDATA%\Programs is removed.
# Only Windows PowerShell's own modules, from its system folder: a look-alike command in the user's module
# folder (Documents) could otherwise run in place of Start-Process and change what the UAC prompt starts.
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$name = 'Markdown Viewer (WebView2)'
$key = 'MarkdownViewerWebView2'
$exeName = "$key.exe"
$progId = "$key.md"
$dist = Join-Path $here 'dist'
# Where earlier versions installed it - from Windows' own record of the folder, not the LOCALAPPDATA
# environment variable (which any program running as you can change).
$userDest = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Programs\$key"
# Program Files as Windows records it (not the ProgramFiles environment variable, which can be set per user).
$dest = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) $key
$exe = Join-Path $dest $exeName
$backupKey = "HKCU:\Software\$key"
$exts = '.md', '.markdown', '.mdown', '.mkd'
# Offered under "Open with" only - the installer never makes the viewer their default app.
$mediaExts = '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.mp4', '.webm', '.mp3', '.wav', '.ogg'
$mediaProgId = "$key.media"

function Quote($s) { "'" + $s.Replace("'", "''") + "'" }

# One command-line argument, quoted by Windows' rules (CommandLineToArgvW), so PowerShell receives the text
# exactly as written: backslashes are literal unless a double quote follows them.
function ConvertTo-NativeArgument([string]$text) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $text.ToCharArray()) {
        if ($ch -eq '\') { $backslashes++; continue }
        if ($ch -eq '"') { [void]$sb.Append('\' * (2 * $backslashes + 1)).Append('"') }
        else { [void]$sb.Append('\' * $backslashes).Append($ch) }
        $backslashes = 0
    }
    [void]$sb.Append('\' * (2 * $backslashes)).Append('"')
    $sb.ToString()
}

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

# Before building: has the project folder changed since the last install? The installed checker and its
# record sit in Program Files, where only an administrator can change them. Changes nobody meant to make
# should not get built and signed unnoticed; changes you made or pulled yourself just need a Y.
$installedChecker = Join-Path $dest 'check-source.ps1'
if ((Test-Path -LiteralPath $installedChecker) -and (Test-Path -LiteralPath (Join-Path $dest 'source-manifest.txt'))) {
    $projectRoot = Split-Path $here -Parent
    & $installedChecker -Root $projectRoot -Quiet
    if ($LASTEXITCODE -eq 0) { Write-Host 'Project folder unchanged since the last install.' }
    elseif ($LASTEXITCODE -eq 1) {
        & $installedChecker -Root $projectRoot | Out-Host
        if (-not (Read-YesNo 'Build and install these changes?')) { Write-Host 'Nothing was built or installed.'; exit 1 }
    }
    else { Write-Host 'The project folder could not be compared with the last install (see above); this install makes a new record.' -ForegroundColor Yellow }
} else {
    Write-Host 'No record from an earlier install yet; this install makes one.'
}

# Record the SHA-256 of every project file before the build; the record is installed in Program Files with
# the program, where only an administrator can change it, and Check-Source.cmd compares the folder with it.
New-Item -ItemType Directory -Force $dist | Out-Null
$recordFile = Join-Path $dist 'source-manifest.txt'
& (Join-Path $here 'check-source.ps1') -Write $recordFile
if ($LASTEXITCODE -ne 0) { Write-Host 'The project files could not be recorded; nothing was installed.'; exit 1 }
# Always rebuild so the installed copy matches the current sources.
& (Join-Path $here 'build.ps1')
# The sources must still be exactly as recorded: a change while building would mean the program was built
# from something other than what the record says.
& (Join-Path $here 'check-source.ps1') -Record $recordFile -Quiet
if ($LASTEXITCODE -ne 0) {
    Write-Host 'The project files changed while the app was being built; nothing was installed.' -ForegroundColor Yellow
    Write-Host 'Run Install.cmd again once nothing is editing the project folder.'
    exit 1
}
# An update must be signed by the same certificate as the installed copy. If it is not (e.g. after a new
# signing certificate was made), you decide: a build you did not make yourself should not be installed.
$accept = ''
$newThumb = (Get-AuthenticodeSignature (Join-Path $dist $exeName)).SignerCertificate.Thumbprint
$installedExe = @((Join-Path $dest $exeName), (Join-Path $userDest $exeName)) | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($installedExe) {
    $oldThumb = (Get-AuthenticodeSignature $installedExe).SignerCertificate.Thumbprint
    if ($oldThumb -and $newThumb -and $oldThumb -ne $newThumb) {
        Write-Host ''
        Write-Host "The new build is signed by a different certificate than the installed copy:"
        Write-Host "  installed: $oldThumb"
        Write-Host "  new build: $newThumb"
        Write-Host 'That is expected only right after a new signing certificate was made on this PC.'
        if (-not (Read-YesNo 'Install the new build?')) { Write-Host 'Nothing was changed.'; exit 1 }
        $accept = $newThumb
    }
}

# Copy the program with place.ps1 - the only step that runs with administrator rights. It copies into a
# staging folder in Program Files, checks the files there and then swaps the folders (see place.ps1).
Write-Host "Copying the program to $dest (Windows asks for administrator rights; 'Show more details' shows place.ps1, its SHA-256 and every file's SHA-256)..."
# The SHA-256 of every file as built, taken now: the administrator step compares each copy with it.
$installFiles = @($exeName, "$key.Content.dll", 'MarkdownViewer.ico', 'source-manifest.txt', 'Microsoft.Web.WebView2.Core.dll',
                  'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll' | ForEach-Object { Join-Path $dist $_ }) +
                @('uninstall.ps1', 'firewall.ps1', 'trust.ps1', 'check-source.ps1', 'register.ps1' | ForEach-Object { Join-Path $here $_ })
$expected = ($installFiles | ForEach-Object { "$(Split-Path $_ -Leaf)=$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash)" }) -join ';'
# What runs as administrator is a short, readable bootstrap - which is what the UAC prompt's "Show more
# details" shows: place.ps1's path and SHA-256, then the data (folders, every file's SHA-256, an accepted
# certificate). As administrator it first limits module loading to PowerShell's own folder (a plain string,
# no command used before that), reads place.ps1's bytes once, checks them against that SHA-256 and runs
# exactly those bytes from memory: a place.ps1 swapped at any moment after this point never runs (exit 8).
$placeFile = Join-Path $here 'place.ps1'
$placeHash = (Get-FileHash -LiteralPath $placeFile -Algorithm SHA256).Hash
$bootstrap = @(
    '$env:PSModulePath = $PSHOME + ''\Modules'''
    '$ErrorActionPreference = ''Stop'''
    "`$codeFile = $(Quote $placeFile)"
    "`$codeHash = '$placeHash'"
    '$bytes = [IO.File]::ReadAllBytes($codeFile)'
    'if (([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)) -replace ''-'', '''') -ne $codeHash) { exit 8 }'
    "`$Source = $(Quote $dist)"
    "`$Scripts = $(Quote $here)"
    "`$Expected = $(Quote $expected)"
    "`$AcceptThumbprint = $(Quote $accept)"
    '& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF))) -Source $Source -Scripts $Scripts -Expected $Expected -AcceptThumbprint $AcceptThumbprint'
) -join '; '
$argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ' + (ConvertTo-NativeArgument $bootstrap)
if ($argLine.Length -gt 30000) { Write-Host 'Internal error: the administrator step is too long for one command line; nothing was installed.'; exit 1 }
$argList = $argLine
# Windows PowerShell by its full path (not whichever powershell.exe comes first on PATH); place.ps1
# itself only uses Windows PowerShell's own modules.
$psExe = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
try { $p = Start-Process $psExe -Verb RunAs -ArgumentList $argList -WindowStyle Hidden -PassThru -Wait }
catch { Write-Host 'Administrator rights were not granted; nothing was installed.'; exit 1 }
if ($p.ExitCode -ne 0) {
    $why = switch ($p.ExitCode) {
        2 { 'the program or its Content DLL is not signed, or was changed after it was signed' }
        3 { 'the new build is signed by a different certificate than the installed copy' }
        4 { 'a WebView2 file does not carry a valid Microsoft signature' }
        5 { 'a file in app\dist is a link, not a plain file' }
        7 { 'a copied file differs from the build (changed while installing?)' }
        8 { 'place.ps1 changed after the installer checked it' }
        default { 'the files could not be copied (is the viewer open in another account?)' }
    }
    Write-Host "Not installed: $why. The installed copy was left as it was."
    exit 1
}
# Check, as you, that Program Files now holds exactly what was built.
# (The administrator step has already refused any difference; this confirms it from your side.)
$keep = @($installFiles | ForEach-Object { Split-Path $_ -Leaf })
$present = @(Get-ChildItem -LiteralPath $dest -Force | ForEach-Object Name)
$differs = @($installFiles | Where-Object {
    $inst = Join-Path $dest (Split-Path $_ -Leaf)
    -not (Test-Path $inst) -or (Get-FileHash $inst).Hash -ne (Get-FileHash $_).Hash
} | ForEach-Object { Split-Path $_ -Leaf }) + @($present | Where-Object { $keep -notcontains $_ })
if ($differs.Count) { Write-Host "WARNING: in $dest these do not match what was built: $($differs -join ', ')" -ForegroundColor Yellow }
else { Write-Host "Copied to $dest and checked: exactly the files that were built." }
# File types, Open with, Start menu and Settings > Apps for your account: register.ps1 from Program Files,
# where only an administrator can change it (the same step Setup.exe runs). It also removes a copy from
# earlier versions in %LOCALAPPDATA%\Programs.
& (Join-Path $dest 'register.ps1')
$registered = $LASTEXITCODE
$version = (Get-Item $exe).VersionInfo.ProductVersion
Write-Host ""
Write-Host "Installed $name $version to $dest"
if ($registered -ne 0) { Write-Host 'Some Windows entries could not be set (see above).' -ForegroundColor Yellow }
# The same build as one signed Setup file, for installing on other PCs (made by build.ps1).
$setupFile = Get-ChildItem -LiteralPath (Join-Path $here 'release') -Filter "MarkdownViewer-Setup-$version.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($setupFile) { Write-Host "For other PCs: $($setupFile.FullName) (one signed file with Install and Uninstall)." }
if (Get-NetFirewallRule -Group $name -ErrorAction SilentlyContinue) { Write-Host 'Firewall: the block rules for this app are in place.' }
else { Write-Host 'Optional: run Firewall-Block.cmd (as administrator) to block all network traffic of the program.' }
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