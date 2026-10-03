# Installs Markdown Viewer for the current user (no admin rights needed):
#   install.ps1            online edition  -> %LOCALAPPDATA%\Programs\MarkdownViewer
#   install.ps1 -Offline   offline edition -> %LOCALAPPDATA%\Programs\MarkdownViewerOffline (side by side)
#   install.ps1 -WebView2  WebView2 edition -> %LOCALAPPDATA%\Programs\MarkdownViewerWebView2 (side by side)
# Each edition gets its own Start menu entries, "Open with" entry, settings and Settings > Apps entry.
# The online edition becomes the default for .md files (unless you chose another default in Windows);
# the other editions are added to "Open with" and become the default only with -MakeDefault.
param([switch]$Offline, [switch]$WebView2, [switch]$MakeDefault)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
. (Join-Path $here 'editions.ps1')
$ed = Get-MdvEdition (Get-MdvKind $Offline.IsPresent $WebView2.IsPresent)
$dist = Join-Path $here $ed.Dist
$dest = $ed.InstallDir
$exe  = Join-Path $dest $ed.Exe
$progId = $ed.ProgId
$exts = '.md', '.markdown', '.mdown', '.mkd'
$setDefault = ($ed.Kind -eq 'online') -or $MakeDefault

# Windows can't replace a running program: close this edition's open viewers (the other edition is untouched).
$running = @(Get-Process $ed.Process -ErrorAction SilentlyContinue)
if ($running.Count) {
    Write-Host "Closing $($running.Count) open $($ed.Name) helper(s) to update the program."
    Write-Host 'Any of its viewer windows that were open need to be reopened (double-click the .md file again).'
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

# Always rebuild so the installed copy matches the current sources.
& (Join-Path $here 'build.ps1') -Offline:($ed.Kind -eq 'offline') -WebView2:$ed.WebView2
New-Item -ItemType Directory -Force $dest | Out-Null
foreach ($f in $ed.Exe, 'MarkdownViewer.ico', 'ReadMe.html', 'viewer.js', 'marked.min.js', 'favicon_readme.png') {
    Copy-Item (Join-Path $dist $f) $dest -Force
}
if ($ed.WebView2) {
    # Microsoft's WebView2 SDK files (signed by Microsoft) next to the program
    foreach ($f in 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll') { Copy-Item (Join-Path $dist $f) $dest -Force }
}
if ($ed.Offline) {
    $libDest = Join-Path $dest 'lib'
    if (Test-Path $libDest) { Remove-Item $libDest -Recurse -Force }
    Copy-Item (Join-Path $dist 'lib') $libDest -Recurse -Force          # bundled libraries
}
foreach ($f in 'uninstall.ps1', 'editions.ps1') { Copy-Item (Join-Path $here $f) $dest -Force }
if ($ed.FirewallAdd) { Copy-Item (Join-Path $here 'firewall.ps1') $dest -Force }   # the WebView2 edition has no firewall rules

# Create a registry key only if it's missing. (New-Item -Force would recreate an existing key and
# wipe its values - e.g. other apps' entries under .md or the other edition's registration.)
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
Set-ItemProperty "$classes\$progId\shell\open" -Name 'FriendlyAppName' -Value $ed.Name

# Application entry (name + icon in "Open with" lists)
$appKey = "$classes\Applications\$($ed.Exe)"
Set-Default "$appKey\shell\open\command" $command
Set-ItemProperty $appKey -Name 'FriendlyAppName' -Value $ed.Name
Set-Default "$appKey\DefaultIcon" "`"$exe`",0"
Ensure-Key "$appKey\SupportedTypes"

Ensure-Key $ed.BackupKey

foreach ($ext in $exts) {
    $extKey = "$classes\$ext"
    Ensure-Key $extKey
    Ensure-Key "$extKey\OpenWithProgids"
    Set-ItemProperty "$extKey\OpenWithProgids" -Name $progId -Value ([byte[]]@()) -Type Binary
    Set-ItemProperty "$appKey\SupportedTypes" -Name $ext -Value ''

    if ($setDefault) {
        # Make it the default for this extension (remember the previous value for uninstall).
        $prev = (Get-ItemProperty $extKey -ErrorAction SilentlyContinue).'(default)'
        if ($prev -and $prev -ne $progId) { Set-ItemProperty $ed.BackupKey -Name "Prev$ext" -Value $prev }
        Set-Item -Path $extKey -Value $progId
    }
    Set-ItemProperty $extKey -Name 'Content Type' -Value 'text/markdown'
    Set-ItemProperty $extKey -Name 'PerceivedType' -Value 'text'
}

# Start menu shortcuts: the viewer (no file: choose a folder / drag & drop) and the About window.
$programs = [Environment]::GetFolderPath('Programs')
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut((Join-Path $programs "$($ed.Name).lnk"))
$sc.TargetPath = $exe
$sc.WorkingDirectory = $dest
$sc.IconLocation = "$exe,0"
$sc.Description = $(switch ($ed.Kind) { 'offline' { 'View Markdown files with figures and math - works offline' } 'webview2' { 'View Markdown files with figures and math - own window, no network port' } default { 'View Markdown files with figures and math' } })
$sc.Save()

$about = $shell.CreateShortcut((Join-Path $programs "About $($ed.Name).lnk"))
$about.TargetPath = $exe
$about.Arguments = '--about'
$about.WorkingDirectory = $dest
$about.IconLocation = "$exe,0"
$about.Description = 'Version, preview-only security, firewall status and library versions'
$about.Save()

# Settings > Apps entry (version, size, Uninstall button)
$version = (Get-Item $exe).VersionInfo.ProductVersion
$sizeKB = [int]((Get-ChildItem $dest -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
$un = $ed.UninstallKey
Ensure-Key $un
Set-ItemProperty $un -Name 'DisplayName' -Value $ed.Name
Set-ItemProperty $un -Name 'DisplayVersion' -Value $version
Set-ItemProperty $un -Name 'Publisher' -Value 'Markdown Viewer'
Set-ItemProperty $un -Name 'Comments' -Value $(switch ($ed.Kind) { 'offline' { 'Preview-only Markdown viewer with figures, math and diagrams - fully offline' } 'webview2' { 'Preview-only Markdown viewer with figures, math and diagrams - WebView2 window, no network port' } default { 'Preview-only Markdown viewer with figures, math and diagrams' } })
Set-ItemProperty $un -Name 'DisplayIcon' -Value "$exe,0"
Set-ItemProperty $un -Name 'InstallLocation' -Value $dest
Set-ItemProperty $un -Name 'EstimatedSize' -Value $sizeKB -Type DWord
Set-ItemProperty $un -Name 'NoModify' -Value 1 -Type DWord
Set-ItemProperty $un -Name 'NoRepair' -Value 1 -Type DWord
$unArgs = switch ($ed.Kind) { 'offline' { ' -Offline' } 'webview2' { ' -WebView2' } default { '' } }
Set-ItemProperty $un -Name 'UninstallString' -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dest\uninstall.ps1`"$unArgs"

# Tell Explorer that file associations changed.
Add-Type -Namespace Win32 -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);' -ErrorAction SilentlyContinue
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Host ""
Write-Host "Installed $($ed.Name) $version to $dest"
if ($setDefault) {
    # If the user already picked another default app in Windows, that choice wins.
    $userChoice = foreach ($ext in $exts) {
        $p = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\UserChoice" -ErrorAction SilentlyContinue).ProgId
        if ($p -and $p -ne $progId) { "$ext -> $p" }
    }
    if ($userChoice) {
        Write-Host "Windows still has another default app for: $($userChoice -join ', ')"
        Write-Host "To switch: right-click a .md file > Open with > Choose another app > $($ed.Name) > Always."
    } elseif ($ed.Kind -eq 'online') {
        Write-Host "Double-click any .md file to open it in $($ed.Name)."
    } else {
        # Windows 11 does not let a program switch the default by itself: the next double-click shows a picker.
        Write-Host "Windows will confirm the change: the next time you double-click a .md file it asks which app to use."
        Write-Host "Pick $($ed.Name) and click Always (or: right-click > Open with > Choose another app > $($ed.Name) > Always)."
    }
} else {
    Write-Host "Open a .md file with it: right-click the file > Open with > $($ed.Name)."
    Write-Host "(To make it the default: right-click > Open with > Choose another app > $($ed.Name) > Always.)"
}
if ($ed.FirewallAdd) { Write-Host "Optional firewall rules for this edition: run $($ed.FirewallAdd)." }
else { Write-Host 'No firewall rules needed: this edition uses no network port.' }
