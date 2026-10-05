# Adds (or with -Remove takes away) the certificate that signs Markdown Viewer (WebView2) to the current
# user's trusted roots, so Windows shows the signature of the program and its Content DLL as valid.
# Optional: the app checks its signatures at every start either way. Windows asks you to confirm the change.
# - Only the copy installed in Program Files is used (only an administrator can change it), found through
#   Windows' own record of that folder - never a copy in a folder any program running as you could fill.
# - Its signer must be your own signing certificate: the one in your personal store with its private key.
# - Only the public certificate is added, straight from memory: no file is written that could be swapped.
[CmdletBinding()]   # unknown parameters (e.g. a program path) are refused, never silently ignored
param([switch]$Remove)
# Only Windows PowerShell's own modules (a look-alike command in the user's Documents module folder could
# otherwise trust a different certificate).
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$key = 'MarkdownViewerWebView2'
$subject = 'CN=Markdown Viewer (WebView2) Code Signing'
$exe = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) "$key\$key.exe"

function Open-Store([string]$name) {
    $store = New-Object Security.Cryptography.X509Certificates.X509Store($name, [Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser)
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $store
}

if ($Remove) {
    # The installed program's signer and any certificate made for this app (earlier versions also added it to
    # Trusted Publishers).
    $thumbs = @()
    if (Test-Path -LiteralPath $exe) { $s = (Get-AuthenticodeSignature -LiteralPath $exe).SignerCertificate; if ($s) { $thumbs += $s.Thumbprint } }
    $removed = 0
    foreach ($name in 'TrustedPublisher', 'Root') {
        $store = Open-Store $name
        try {
            foreach ($c in @($store.Certificates | Where-Object { $thumbs -contains $_.Thumbprint -or $_.Subject -eq $subject })) { $store.Remove($c); $removed++ }
        } finally { $store.Close() }
    }
    Write-Host "Removed $removed trusted entr$(if ($removed -eq 1) { 'y' } else { 'ies' }) for $subject."
    exit 0
}

if (-not (Test-Path -LiteralPath $exe)) { throw "$exe not found: install the app first (Install.cmd). Only the installed copy in Program Files is used." }
$sig = Get-AuthenticodeSignature -LiteralPath $exe
if (-not $sig.SignerCertificate -or $sig.Status -in 'HashMismatch', 'NotSigned', 'NotSupportedFileFormat', 'Incompatible') {
    throw "$exe is not signed, or was changed after it was signed ($($sig.Status)). Nothing was trusted."
}
$signer = $sig.SignerCertificate
# Must be your own signing certificate, the one this PC's builds sign with (it has the private key).
$own = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $signer.Thumbprint -and $_.HasPrivateKey })
if (-not $own.Count) {
    throw "The installed program is signed by $($signer.Subject) ($($signer.Thumbprint)), which is not your own signing certificate on this PC. Nothing was trusted."
}
# Trusted Roots only: enough for Windows to show the signature as valid. Not Trusted Publishers - Office
# macros and AllSigned PowerShell run code from those publishers without asking, which this app never needs.
$public = New-Object Security.Cryptography.X509Certificates.X509Certificate2(, $signer.RawData)   # public part only
$store = Open-Store 'Root'
try { $store.Add($public) }
catch { throw "The certificate was not added (declined or failed): $($_.Exception.Message)" }
finally { $store.Close() }
Write-Host "Trusted $($signer.Subject) ($($signer.Thumbprint)) for your user account."
Write-Host ("Signature of the program now: " + (Get-AuthenticodeSignature -LiteralPath $exe).Status)
