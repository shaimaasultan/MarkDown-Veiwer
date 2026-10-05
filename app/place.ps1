# Installs the built program in C:\Program Files\MarkdownViewerWebView2. Run by install.ps1 with
# administrator rights (one UAC prompt); everything else in the install runs as the user. The elevated
# PowerShell gets a short readable bootstrap (what the UAC details show): this file's path and SHA-256 and the
# data below. It reads this file's bytes once, checks the SHA-256 and runs exactly those bytes from memory,
# so a copy swapped between the prompt and the start never runs.
#   -Source            the built program (app\dist)
#   -Scripts           the folder with uninstall.ps1, firewall.ps1, trust.ps1 and check-source.ps1 (app)
#   -Expected          name=SHA-256;... of every file as built: each copy is compared with it
#   -AcceptThumbprint  a new signing certificate the user has confirmed
# Run as administrator, this script trusts nothing it is handed:
#   - the install folder is worked out here, from Windows' own record of Program Files (not the ProgramFiles
#     environment variable, which can be set per user), so nothing passed in decides what is created or removed;
#   - the files are copied into a staging folder inside Program Files first, which only administrators can
#     change, and checked there - so what was checked is what gets installed;
#   - it writes no log file: results come back as the exit code (see install.ps1), so no file in the user's
#     folders can be made to point it at a system file.
# Exit codes: 0 done, 2 program/Content DLL not intact or not signed, 3 signed by another certificate than
# the installed copy, 4 a WebView2 file not signed by Microsoft, 5 a source file is a link, 6 in use / other,
# 7 a copied file differs from the build (nothing is installed).
param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Scripts,
      [Parameter(Mandatory)][string]$Expected, [string]$AcceptThumbprint)
# Only Windows PowerShell's own modules, from its system folder (set before any command is used): run as
# administrator, a look-alike Copy-Item in the user's module folder (Documents) would run as administrator.
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$name = 'Markdown Viewer (WebView2)'
$exeName = 'MarkdownViewerWebView2.exe'
$contentName = 'MarkdownViewerWebView2.Content.dll'
$msFiles = 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'
$scriptFiles = 'uninstall.ps1', 'firewall.ps1', 'trust.ps1', 'check-source.ps1'
$dest = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'MarkdownViewerWebView2'
$stage = "$dest.new"
$old = "$dest.old"

function Fail([int]$code) { throw (New-Object System.Exception "exit $code") }
function Clear-Dir($path) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force } }

try {
    Clear-Dir $stage; Clear-Dir $old
    New-Item -ItemType Directory $stage | Out-Null
    # source-manifest.txt: the project files' SHA-256 at install time (made by install.ps1, read by Check-Source.cmd).
    $copies = @(@($exeName, $contentName, 'MarkdownViewer.ico', 'source-manifest.txt') + $msFiles | ForEach-Object { Join-Path $Source $_ }) +
              @($scriptFiles | ForEach-Object { Join-Path $Scripts $_ })
    foreach ($f in $copies) {
        # Plain files only: a link could make this administrator copy read a file the user cannot.
        if ((Get-Item -LiteralPath $f -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail 5 }
        Copy-Item -LiteralPath $f $stage
    }

    # Checked in the staging folder, which only administrators can change. First: every copy must be exactly
    # the file that was built (SHA-256 taken by install.ps1 before this step), and nothing else may be there.
    $want = @{}
    foreach ($pair in $Expected.Split(';')) { $kv = $pair.Split('=', 2); if ($kv.Count -eq 2) { $want[$kv[0]] = $kv[1] } }
    $staged = @(Get-ChildItem -LiteralPath $stage -Force)
    if ($staged.Count -ne $want.Count) { Fail 7 }
    foreach ($f in $staged) {
        if (-not $want.ContainsKey($f.Name) -or (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash -ne $want[$f.Name]) { Fail 7 }
    }
    $thumbs = foreach ($f in $exeName, $contentName) {
        $s = Get-AuthenticodeSignature (Join-Path $stage $f)
        if (-not $s.SignerCertificate -or $s.Status -in 'HashMismatch', 'NotSigned', 'NotSupportedFileFormat', 'Incompatible') { Fail 2 }
        $s.SignerCertificate.Thumbprint
    }
    if ($thumbs[0] -ne $thumbs[1]) { Fail 2 }
    $installed = Join-Path $dest $exeName
    if (Test-Path -LiteralPath $installed) {
        $was = (Get-AuthenticodeSignature $installed).SignerCertificate.Thumbprint
        if ($was -and $was -ne $thumbs[0] -and $thumbs[0] -ne $AcceptThumbprint) { Fail 3 }
    }
    foreach ($f in $msFiles) {
        $s = Get-AuthenticodeSignature (Join-Path $stage $f)
        if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation,') { Fail 4 }
    }

    # Swap the folders. Renaming fails as a whole while a file in the old folder is in use, so a running
    # copy is never left half replaced. Anything else that was in the old folder goes with it.
    if (Test-Path -LiteralPath $dest) { Rename-Item -LiteralPath $dest -NewName (Split-Path $old -Leaf) }
    Rename-Item -LiteralPath $stage -NewName (Split-Path $dest -Leaf)
    Clear-Dir $old

    # Firewall block rules (Firewall-Block.cmd) name the program's path: keep them on the installed copy.
    $rules = @(Get-NetFirewallRule -Group $name -ErrorAction SilentlyContinue)
    if ($rules.Count) { $rules | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program (Join-Path $dest $exeName) }
    exit 0
} catch {
    $code = if ($_.Exception.Message -match '^exit (\d)$') { [int]$Matches[1] } else { 6 }
    try { Clear-Dir $stage } catch { }
    # A failed swap: put the previous copy back.
    if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath $dest)) { try { Rename-Item -LiteralPath $old -NewName (Split-Path $dest -Leaf) } catch { } }
    exit $code
}
