# Copies the built program into its install folder and removes anything else from that folder.
# Called by install.ps1: directly for a per-user install, with administrator rights (one UAC prompt) for
# a Program Files install. All paths are passed in, so they stay the installing user's even if Windows
# asks for a different administrator account. Output also goes to -Log, which install.ps1 shows.
param([Parameter(Mandatory)][string]$Source, [Parameter(Mandatory)][string]$Scripts,
      [Parameter(Mandatory)][string]$Dest, [string]$Log, [string]$AcceptThumbprint)
# Run with administrator rights, PowerShell would otherwise look for commands such as Copy-Item in the
# user's own module folder (Documents) first: a look-alike module there would run as administrator.
# Only Windows PowerShell's own modules, from its system folder (set before any command is used).
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$name = 'Markdown Viewer (WebView2)'
$exeName = 'MarkdownViewerWebView2.exe'
$programFiles = 'MarkdownViewerWebView2.Content.dll', 'MarkdownViewer.ico',
                'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'
$scriptFiles = 'uninstall.ps1', 'firewall.ps1', 'trust.ps1'

function Say($text) { Write-Host $text; if ($Log) { Add-Content -Path $Log -Value $text -Encoding UTF8 } }

try {
    # The new program and Content DLL must be intact and signed by one certificate - the same one as the
    # copy already installed here, unless the installing user confirmed this new certificate.
    $new = foreach ($f in $exeName, 'MarkdownViewerWebView2.Content.dll') {
        $s = Get-AuthenticodeSignature (Join-Path $Source $f)
        if (-not $s.SignerCertificate -or $s.Status -in 'HashMismatch', 'NotSigned', 'NotSupportedFileFormat', 'Incompatible') {
            throw "$f in $Source is not signed or has been changed since it was signed ($($s.Status))."
        }
        $s.SignerCertificate.Thumbprint
    }
    if ($new[0] -ne $new[1]) { throw "The program and its Content DLL in $Source are signed by different certificates." }
    $installed = Join-Path $Dest $exeName
    if (Test-Path $installed) {
        $old = (Get-AuthenticodeSignature $installed).SignerCertificate.Thumbprint
        if ($old -and $old -ne $new[0] -and $new[0] -ne $AcceptThumbprint) {
            throw "The new build is signed by certificate $($new[0]), not by $old like the installed copy; nothing was changed."
        }
    }

    New-Item -ItemType Directory -Force $Dest | Out-Null
    # The page and every library are inside the signed MarkdownViewerWebView2.Content.dll - no loose script files.
    foreach ($f in @($exeName) + $programFiles) { Copy-Item (Join-Path $Source $f) $Dest -Force }
    foreach ($f in $scriptFiles) { Copy-Item (Join-Path $Scripts $f) $Dest -Force }
    # Only the program's own files may be in its folder (the program refuses to start otherwise): remove
    # anything else - files earlier versions left behind (loose page files, lib\) or files put there since.
    $keep = @($exeName) + $programFiles + $scriptFiles
    Get-ChildItem -LiteralPath $Dest -Force | Where-Object { $keep -notcontains $_.Name -or $_.PSIsContainer } | ForEach-Object {
        Say "Removing $($_.Name) from the program folder (not part of $name)."
        Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
    # Firewall block rules (Firewall-Block.cmd) name the program's path: keep them on the installed copy.
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $rules = @(Get-NetFirewallRule -Group $name -ErrorAction SilentlyContinue)
    if ($admin -and $rules.Count) {
        $exe = Join-Path $Dest $exeName
        $rules | Get-NetFirewallApplicationFilter | Set-NetFirewallApplicationFilter -Program $exe
        Say "Firewall block rules now apply to $exe"
    }
    Say "Copied to $Dest"
    exit 0
} catch {
    Say "Failed: $($_.Exception.Message)"
    exit 1
}
