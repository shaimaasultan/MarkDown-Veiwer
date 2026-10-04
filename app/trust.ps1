# Adds (or with -Remove takes away) the certificate that signs Markdown Viewer (WebView2) to the current
# user's trusted roots, so Windows shows the signature of the program and its Content DLL as valid.
# Optional: the app checks its signatures at every start either way. Only the public certificate is
# copied (taken from the signed program); Windows asks you to confirm the change to the trusted roots.
param([switch]$Remove, [string]$Exe)
# Only Windows PowerShell's own modules (a look-alike Import-Certificate in the user's Documents module folder
# could otherwise trust a different certificate).
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$key = 'MarkdownViewerWebView2'
if (-not $Exe) { $Exe = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) "$key\$key.exe" }
if (-not (Test-Path $Exe)) { $Exe = Join-Path $env:LOCALAPPDATA "Programs\$key\$key.exe" }
if (-not (Test-Path $Exe)) { $Exe = Join-Path $PSScriptRoot "dist\$key.exe" }
if (-not (Test-Path $Exe)) { throw "$key.exe not found; install the app first." }

$cert = (Get-AuthenticodeSignature $Exe).SignerCertificate
if (-not $cert) { throw "$Exe is not signed." }
# Trusted Roots only: enough for Windows to show the signature as valid. Not Trusted Publishers - Office
# macros and AllSigned PowerShell run code from those publishers without asking, which this app never needs.
$stores = @('Root')

if ($Remove) {
    # Earlier versions also added it to Trusted Publishers.
    foreach ($s in 'TrustedPublisher', 'Root') { Get-ChildItem "Cert:\CurrentUser\$s" | Where-Object Thumbprint -eq $cert.Thumbprint | Remove-Item }
    Write-Host "Removed $($cert.Subject) ($($cert.Thumbprint)) from your trusted roots (and trusted publishers)."
} else {
    $cer = Join-Path $env:TEMP "$key-signing.cer"
    [IO.File]::WriteAllBytes($cer, $cert.Export('Cert'))       # public part only
    try { foreach ($s in $stores) { Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\CurrentUser\$s" | Out-Null } }
    finally { Remove-Item $cer -ErrorAction SilentlyContinue }
    Write-Host "Trusted $($cert.Subject) ($($cert.Thumbprint)) for your user account."
}
Write-Host ("Signature of the program now: " + (Get-AuthenticodeSignature $Exe).Status)
