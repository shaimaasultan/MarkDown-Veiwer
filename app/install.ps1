# Installs Markdown Viewer (WebView2) for the current user (no admin rights needed):
#   %LOCALAPPDATA%\Programs\MarkdownViewerWebView2, Start menu entries, Settings > Apps entry,
#   and the .md / .markdown / .mdown / .mkd file association.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$name = 'Markdown Viewer (WebView2)'
$key = 'MarkdownViewerWebView2'
$exeName = "$key.exe"
$progId = "$key.md"
$dist = Join-Path $here 'dist'
$dest = Join-Path $env:LOCALAPPDATA "Programs\$key"
$exe = Join-Path $dest $exeName
$backupKey = "HKCU:\Software\$key"
$exts = '.md', '.markdown', '.mdown', '.mkd'

# Windows can't replace a running program: close open viewer windows first.
$running = @(Get-Process $key -ErrorAction SilentlyContinue)
if ($running.Count) {
    Write-Host "Closing $($running.Count) open $name window(s) to update the program; reopen your documents afterwards."
    $running | Stop-Process -Force
    Start-Sleep -Milliseconds 500
}

# Always rebuild so the installed copy matches the current sources.
& (Join-Path $here 'build.ps1')
New-Item -ItemType Directory -Force $dest | Out-Null
# The page and every library are inside the signed MarkdownViewerWebView2.Content.dll - no loose script files.
foreach ($f in $exeName, 'MarkdownViewerWebView2.Content.dll', 'MarkdownViewer.ico',
               'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll') {
    Copy-Item (Join-Path $dist $f) $dest -Force
}
foreach ($f in 'uninstall.ps1', 'firewall.ps1', 'trust.ps1') { Copy-Item (Join-Path $here $f) $dest -Force }
# Files earlier versions left behind: loose page files and libraries (the page was once called ReadMe.html).
foreach ($f in 'viewer.html', 'viewer.js', 'marked.min.js', 'favicon_readme.png', 'editions.ps1', 'ReadMe.html') {
    Remove-Item (Join-Path $dest $f) -Force -ErrorAction SilentlyContinue
}
Remove-Item (Join-Path $dest 'lib') -Recurse -Force -ErrorAction SilentlyContinue

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
Set-ItemProperty $un -Name 'UninstallString' -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dest\uninstall.ps1`""

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
$sig = Get-AuthenticodeSignature $exe
Write-Host "Signed by $($sig.SignerCertificate.Subject) ($($sig.SignerCertificate.Thumbprint))."
if ($sig.Status -ne 'Valid') { Write-Host 'Optional: run Trust-Certificate.cmd so Windows also lists this certificate as a trusted publisher.' }
