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
                @('uninstall.ps1', 'firewall.ps1', 'trust.ps1', 'check-source.ps1' | ForEach-Object { Join-Path $here $_ })
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
# A copy from earlier versions is no longer used.
if (Test-Path (Join-Path $userDest $exeName)) {
    Remove-Item -LiteralPath $userDest -Recurse -Force
    Write-Host "Removed the earlier copy in $userDest"
}

# Create a registry key only if it's missing. (New-Item -Force would recreate an existing key and
# wipe its values - e.g. other apps' entries under .md.)
function Ensure-Key($path) {
    if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
}

function Set-Default($path, $value) {
    Ensure-Key $path
    Set-Item -Path $path -Value $value
}

$classes = 'HKCU:\Software\Classes'
$command = "`"$exe`" `"%1`""

# File type (ProgID)
Set-Default "$classes\$progId" 'Markdown Document'
Set-Default "$classes\$progId\DefaultIcon" "`"$exe`",0"
Set-Default "$classes\$progId\shell\open\command" $command
Set-ItemProperty "$classes\$progId\shell\open" -Name 'FriendlyAppName' -Value $name

# Application entry (name + icon in "Open with" lists)
$appKey = "$classes\Applications\$exeName"
Set-Default "$appKey\shell\open\command" $command
Set-ItemProperty $appKey -Name 'FriendlyAppName' -Value $name
Set-Default "$appKey\DefaultIcon" "`"$exe`",0"
Ensure-Key "$appKey\SupportedTypes"

Ensure-Key $backupKey

foreach ($ext in $exts) {
    $extKey = "$classes\$ext"
    Ensure-Key $extKey
    Ensure-Key "$extKey\OpenWithProgids"
    Set-ItemProperty "$extKey\OpenWithProgids" -Name $progId -Value ([byte[]]@()) -Type Binary
    Set-ItemProperty "$appKey\SupportedTypes" -Name $ext -Value ''

    # Make it the default for this extension (remember the previous value for uninstall).
    $prev = (Get-ItemProperty $extKey -ErrorAction SilentlyContinue).'(default)'
    if ($prev -and $prev -ne $progId) { Set-ItemProperty $backupKey -Name "Prev$ext" -Value $prev }
    Set-Item -Path $extKey -Value $progId
    Set-ItemProperty $extKey -Name 'Content Type' -Value 'text/markdown'
    Set-ItemProperty $extKey -Name 'PerceivedType' -Value 'text'
}

# "Open with" for pictures, video and audio: shown in the viewer's own page.
Set-Default "$classes\$mediaProgId" 'Picture, video or audio'
Set-Default "$classes\$mediaProgId\DefaultIcon" "`"$exe`",0"
Set-Default "$classes\$mediaProgId\shell\open\command" $command
Set-ItemProperty "$classes\$mediaProgId\shell\open" -Name 'FriendlyAppName' -Value $name
foreach ($ext in $mediaExts) {
    Ensure-Key "$classes\$ext\OpenWithProgids"
    Set-ItemProperty "$classes\$ext\OpenWithProgids" -Name $mediaProgId -Value ([byte[]]@()) -Type Binary
    Set-ItemProperty "$appKey\SupportedTypes" -Name $ext -Value ''
}

# Start menu shortcuts: the viewer (no file: choose a folder / drag & drop) and the About window.
$programs = [Environment]::GetFolderPath('Programs')
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut((Join-Path $programs "$name.lnk"))
$sc.TargetPath = $exe
$sc.WorkingDirectory = $dest
$sc.IconLocation = "$exe,0"
$sc.Description = 'View Markdown files with figures and math - own window, no network port'
$sc.Save()

$about = $shell.CreateShortcut((Join-Path $programs "About $name.lnk"))
$about.TargetPath = $exe
$about.Arguments = '--about'
$about.WorkingDirectory = $dest
$about.IconLocation = "$exe,0"
$about.Description = 'Version, preview-only security, WebView2 and library versions'
$about.Save()

# Settings > Apps entry (version, size, Uninstall button)
$version = (Get-Item $exe).VersionInfo.ProductVersion
$sizeKB = [int]((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
$un = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$key"
Ensure-Key $un
Set-ItemProperty $un -Name 'DisplayName' -Value $name
Set-ItemProperty $un -Name 'DisplayVersion' -Value $version
Set-ItemProperty $un -Name 'Publisher' -Value 'Markdown Viewer'
Set-ItemProperty $un -Name 'Comments' -Value 'Preview-only Markdown viewer with figures, math and diagrams - WebView2 window, no network port'
Set-ItemProperty $un -Name 'DisplayIcon' -Value "$exe,0"
Set-ItemProperty $un -Name 'InstallLocation' -Value $dest
Set-ItemProperty $un -Name 'EstimatedSize' -Value $sizeKB -Type DWord
Set-ItemProperty $un -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty $un -Name 'NoRepair' -Value 1 -Type DWord
# PowerShell by its full path: Settings would otherwise look "powershell.exe" up (App Paths, PATH).
$psExe = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
Set-ItemProperty $un -Name 'UninstallString' -Value "`"$psExe`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dest\uninstall.ps1`""

# Read the entries back: Windows must now start this copy. (Something else holding on to the old values,
# e.g. a security tool undoing changes to file types, would otherwise go unnoticed.)
$stale = @(foreach ($k in "$classes\$progId\shell\open\command", "$appKey\shell\open\command", "$classes\$mediaProgId\shell\open\command") {
    $v = (Get-ItemProperty $k -ErrorAction SilentlyContinue).'(default)'
    if ($v -ne $command) { "  $k = $v" }
})
if ((Get-ItemProperty $un -ErrorAction SilentlyContinue).DisplayVersion -ne $version) { $stale += "  $un (version)" }
if ($stale.Count) {
    Write-Host 'WARNING: these entries did not take the new values, so Windows may still start another copy:' -ForegroundColor Yellow
    $stale | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
}

# Tell Explorer that file associations changed.
Add-Type -Namespace Win32 -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);' -ErrorAction SilentlyContinue
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host ""
Write-Host "Installed $name $version to $dest"
# If the user picked a default app in Windows ("Always"), that choice wins over the installer.
$userChoice = foreach ($ext in $exts) {
    $p = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\UserChoice" -ErrorAction SilentlyContinue).ProgId
    if ($p -and $p -ne $progId) { "$ext -> $p" }
}
if ($userChoice) {
    Write-Host "Windows still has another default app for: $($userChoice -join ', ')"
    Write-Host "To switch: right-click a .md file > Open with > Choose another app > $name > Always."
} else {
    Write-Host "If Windows asks which app to use the next time you open a .md file, pick $name and click Always."
}
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