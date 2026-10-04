# Adds (or with -Remove takes away) the certificate that signs Markdown Viewer (WebView2) to the current
# user's trusted lists, so Windows shows the program and its Content DLL as signed by a trusted publisher.
# Optional: the app checks its signatures at every start either way. Only the public certificate is
# copied (taken from the signed program); Windows asks you to confirm the change to the trusted roots.
param([switch]$Remove, [string]$Exe)
$ErrorActionPreference = 'Stop'
$key = 'MarkdownViewerWebView2'
if (-not $Exe) { $Exe = Join-Path $env:ProgramFiles "$key\$key.exe" }
if (-not (Test-Path $Exe)) { $Exe = Join-Path $env:LOCALAPPDATA "Programs\$key\$key.exe" }
if (-not (Test-Path $Exe)) { $Exe = Join-Path $PSScriptRoot "dist\$key.exe" }
if (-not (Test-Path $Exe)) { throw "$key.exe not found; install the app first." }

$cert = (Get-AuthenticodeSignature $Exe).SignerCertificate
if (-not $cert) { throw "$Exe is not signed." }
$stores = 'TrustedPublisher', 'Root'

if ($Remove) {
    foreach ($s in $stores) { Get-ChildItem "Cert:\CurrentUser\$s" | Where-Object Thumbprint -eq $cert.Thumbprint | Remove-Item }
    Write-Host "Removed $($cert.Subject) ($($cert.Thumbprint)) from your trusted publishers and roots."
} else {
    $cer = Join-Path $env:TEMP "$key-signing.cer"
    [IO.File]::WriteAllBytes($cer, $cert.Export('Cert'))       # public part only
    try { foreach ($s in $stores) { Import-Certificate -FilePath $cer -CertStoreLocation "Cert:\CurrentUser\$s" | Out-Null } }
    finally { Remove-Item $cer -ErrorAction SilentlyContinue }
    Write-Host "Trusted $($cert.Subject) ($($cert.Thumbprint)) for your user account."
}
Write-Host ("Signature of the program now: " + (Get-AuthenticodeSignature $Exe).Status)
