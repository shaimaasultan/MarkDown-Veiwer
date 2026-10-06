# Builds Markdown Viewer (WebView2) with the C# compiler that ships with Windows (.NET Framework 4).
#   build.ps1  ->  .\dist\MarkdownViewerWebView2.exe and MarkdownViewerWebView2.Content.dll (the page and the
#                  bundled libraries as resources - no loose script files), both signed, plus Microsoft's
#                  WebView2 SDK files it needs; and .\release\MarkdownViewer-Setup-<version>.exe, one signed
#                  file that installs the program on any PC.
#   -CertificateThumbprint <thumbprint>  sign with that code-signing certificate from Cert:\CurrentUser\My
#                  (e.g. one bought from a certificate authority). Without it, the build uses - or creates
#                  once - a certificate on this PC named "Markdown Viewer (WebView2) Code Signing", whose key
#                  is protected: Windows asks you to confirm each time it signs.
param([string]$CertificateThumbprint)
# Only Windows PowerShell's own modules (a look-alike Set-AuthenticodeSignature or Get-AuthenticodeSignature
# in the user's Documents module folder could otherwise feed its own files to the signing key).
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
# Never built with administrator rights: the compiler and the build steps have no need for them. (With User
# Account Control off there is no other way.)
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$uac = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).EnableLUA -ne 0
if ($elevated -and $uac) { throw 'Run the build from a normal window, not as administrator.' }
$here = $PSScriptRoot
$root = Split-Path $here -Parent
$dist = Join-Path $here 'dist'
$exeName = 'MarkdownViewerWebView2.exe'
$contentName = 'MarkdownViewerWebView2.Content.dll'
$certSubject = 'CN=Markdown Viewer (WebView2) Code Signing'
$srcDir = Join-Path $root 'src'           # the viewer page, marked and lib\ (packed into the Content DLL)
$wv2 = Join-Path $root 'webview2'          # Microsoft.Web.WebView2 SDK files (Core, WinForms, WebView2Loader)
$sdkFiles = 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'
$pageFiles = 'viewer.html', 'viewer.js', 'marked.min.js', 'favicon_readme.png'
New-Item -ItemType Directory -Force $dist | Out-Null

# The compiler from the Windows folder as Windows reports it (not the WINDIR variable, which can be set per
# user), and only with Microsoft's valid signature.
$csc = Join-Path ([Environment]::GetFolderPath('Windows')) 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw 'The 64-bit C# compiler (csc.exe) from .NET Framework 4 was not found.' }
$cscSig = Get-AuthenticodeSignature $csc
if ($cscSig.Status -ne 'Valid' -or $cscSig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation,') { throw "$csc does not carry a valid Microsoft signature." }
# The WebView2 SDK files must be exactly these (SDK 1.0.4258.31) and carry Microsoft's valid signature. A
# changed file stops the build before anything is compiled or signed - including a Microsoft-signed file of
# another version. Update these hashes together with the SDK files.
$sdkHashes = @{
    'Microsoft.Web.WebView2.Core.dll'     = 'D60E6E94245078CB56E44EBD5F360DC04BF18E460136BE93BFC4CFCA43B98505'
    'Microsoft.Web.WebView2.WinForms.dll' = '6A9E6856F23C463783C3AFB0CA5D78F56324C86657162CCB16D5227B3233B32A'
    'WebView2Loader.dll'                  = '3426DCC55FDFB8B5E7AC623CF33B4CCF283FBF68A0C5A65BDDFDB4D749A8ABEE'
}
foreach ($f in $sdkFiles) {
    $p = Join-Path $wv2 $f
    if (-not (Test-Path $p)) { throw "WebView2 SDK file missing: $p" }
    $s = Get-AuthenticodeSignature $p
    if ($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation,') { throw "WebView2 SDK file $f does not carry a valid Microsoft signature ($($s.Status))." }
    if ((Get-FileHash $p -Algorithm SHA256).Hash -ne $sdkHashes[$f]) { throw "WebView2 SDK file $f is not the expected version (SHA-256 differs)." }
}
if (-not (Test-Path (Join-Path $srcDir 'lib'))) { throw "Bundled libraries not found in $srcDir\lib." }

# --- Checks on the page sources
# The bundled library files must be the versions viewer.js lists (both About windows show those).
$js = [IO.File]::ReadAllText((Join-Path $srcDir 'viewer.js'))
$files = @{ 'marked' = 'marked.min.js'; 'KaTeX' = 'lib\katex\katex.min.js'; 'highlight.js' = 'lib\highlight\highlight.min.js'; 'Mermaid' = 'lib\mermaid\mermaid.min.js' }
foreach ($lib in $files.Keys) {
    $m = [regex]::Match($js, "name: '$([regex]::Escape($lib))', version: '([^']+)'")
    if (-not $m.Success) { throw "viewer.js does not list a version for $lib." }
    $text = [IO.File]::ReadAllText((Join-Path $srcDir $files[$lib]))
    if (-not $text.Contains('"' + $m.Groups[1].Value + '"') -and -not $text.Contains('v' + $m.Groups[1].Value)) {
        throw "$($files[$lib]) is not $lib $($m.Groups[1].Value) as listed in viewer.js."
    }
}
# Nothing the page loads may point to the internet.
$page = [IO.File]::ReadAllText((Join-Path $srcDir 'viewer.html'))
if ($page -match '(?:src|href)="https?:') { throw 'The page loads something from the internet; every library must come from lib\.' }

# --- App icon: favicon_readme.png scaled to 256/48/32/16 and packed into an .ico (PNG entries).
Add-Type -AssemblyName System.Drawing
$ico = Join-Path $dist 'MarkdownViewer.ico'
$src = [System.Drawing.Image]::FromFile((Join-Path $srcDir 'favicon_readme.png'))
try {
    $images = foreach ($size in 256, 48, 32, 16) {
        $bmp = New-Object System.Drawing.Bitmap $size, $size
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = 'HighQualityBicubic'
        $g.DrawImage($src, 0, 0, $size, $size)
        $g.Dispose()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        , @($size, $ms.ToArray())
    }
} finally { $src.Dispose() }

$fs = [System.IO.File]::Create($ico)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$images.Count)
$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
    $s = $img[0]; $bytes = $img[1]
    $dim = if ($s -ge 256) { 0 } else { $s }
    $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([UInt16]1); $w.Write([UInt16]32)
    $w.Write([UInt32]$bytes.Length); $w.Write([UInt32]$offset)
    $offset += $bytes.Length
}
foreach ($img in $images) { $w.Write([byte[]]$img[1]) }
$w.Dispose()

# --- The WebView2 files' SHA-256, compiled into the (signed) program: at start it accepts exactly these files.
# Generated next to the build output, not in the shared Temp folder, so it is compiled as it was written.
$pinned = Join-Path $dist 'PinnedFiles.cs'
$pins = foreach ($f in $sdkFiles) { "        { `"$f`", `"$((Get-FileHash (Join-Path $wv2 $f) -Algorithm SHA256).Hash)`" }," }
[System.IO.File]::WriteAllText($pinned, @"
// Generated by build.ps1: SHA-256 of the WebView2 files this program was built with.
static class PinnedFiles
{
    static readonly System.Collections.Generic.Dictionary<string, string> Hashes = new System.Collections.Generic.Dictionary<string, string>(System.StringComparer.OrdinalIgnoreCase)
    {
$($pins -join "`r`n")
    };
    public static bool Matches(string file, string sha256)
    {
        string h;
        return Hashes.TryGetValue(file, out h) && string.Equals(h, sha256, System.StringComparison.OrdinalIgnoreCase);
    }
}
"@)

# --- Compile the program (x64: WebView2Loader.dll is the x64 build)
$cscArgs = @('/nologo', '/target:winexe', '/optimize+', '/platform:x64',
             "/out:$(Join-Path $dist $exeName)", "/win32icon:$ico",
             '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Core.dll', '/r:Microsoft.CSharp.dll',
             '/r:System.Management.dll',
             "/r:$(Join-Path $wv2 'Microsoft.Web.WebView2.Core.dll')",
             "/r:$(Join-Path $wv2 'Microsoft.Web.WebView2.WinForms.dll')",
             (Join-Path $here 'MarkdownViewerWebView2.cs'), $pinned)
& $csc @cscArgs
$cscExit = $LASTEXITCODE
Remove-Item $pinned -ErrorAction SilentlyContinue
if ($cscExit -ne 0) { throw "Compilation failed ($cscExit)." }

# --- Compile the Content DLL: page files and lib\ as resources named by their path ("lib/katex/katex.min.js").
$resources = @(foreach ($f in $pageFiles) { "/resource:`"$(Join-Path $srcDir $f)`",$f" })
$resources += Get-ChildItem (Join-Path $srcDir 'lib') -Recurse -File | ForEach-Object {
    $name = $_.FullName.Substring($srcDir.Length + 1).Replace('\', '/')
    "/resource:`"$($_.FullName)`",$name"
}
$rsp = Join-Path $dist 'content.rsp'
$rspLines = @('/nologo', '/target:library', '/optimize+', '/platform:anycpu',
              "/out:`"$(Join-Path $dist $contentName)`"") + $resources + "`"$(Join-Path $here 'Content.cs')`""
[IO.File]::WriteAllLines($rsp, [string[]]$rspLines)
& $csc "@$rsp"
$code = $LASTEXITCODE
Remove-Item $rsp
if ($code -ne 0) { throw "Compiling $contentName failed ($code)." }

# --- Sign the program and the Content DLL with the same certificate
if ($CertificateThumbprint) {
    $cert = Get-Item "Cert:\CurrentUser\My\$CertificateThumbprint" -ErrorAction SilentlyContinue
    if (-not $cert) { throw "Certificate $CertificateThumbprint not found in Cert:\CurrentUser\My." }
} else {
    # Only a certificate whose private key is protected: Windows asks you before anything signs with it,
    # so no other program running as you can quietly sign a changed program or Content DLL with it.
    function Test-Protected($c) {
        try { [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c).Key.UIPolicy.ProtectionLevel -ne 'None' }
        catch { $false }
    }
    $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -eq $certSubject -and $_.NotAfter -gt (Get-Date).AddDays(30) } |
            Where-Object { Test-Protected $_ } | Sort-Object NotAfter -Descending | Select-Object -First 1
    if (-not $cert) {
        Write-Host "Creating a protected code-signing certificate '$certSubject'. Windows will ask you to confirm;"
        Write-Host 'from now on it asks each time a build signs with it (that is the protection).'
        # Private key stays on this PC, cannot be exported, and is used only after you confirm.
        $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $certSubject -CertStoreLocation Cert:\CurrentUser\My `
                    -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable `
                    -KeyProtection Protect -NotAfter (Get-Date).AddYears(10)
        if (-not (Test-Protected $cert)) { throw "The new certificate $($cert.Thumbprint) did not get a protected key." }
        Write-Host "Created the code-signing certificate '$certSubject' ($($cert.Thumbprint)) in your personal certificate store."
        $old = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $certSubject -and $_.Thumbprint -ne $cert.Thumbprint })
        if ($old.Count) {
            Write-Host "Earlier certificate(s) with unprotected keys, no longer used: $($old.Thumbprint -join ', ')"
            Write-Host 'You can delete them in certmgr.msc > Personal > Certificates.'
        }
    }
}
if (-not $cert.HasPrivateKey) { throw "Certificate $($cert.Thumbprint) has no private key on this PC; it cannot sign." }
foreach ($f in $exeName, $contentName) {
    $path = Join-Path $dist $f
    Set-AuthenticodeSignature -FilePath $path -Certificate $cert -HashAlgorithm SHA256 | Out-Null
    $sig = Get-AuthenticodeSignature $path
    if (-not $sig.SignerCertificate -or $sig.SignerCertificate.Thumbprint -ne $cert.Thumbprint) { throw "Signing $f failed ($($sig.StatusMessage))." }
}

# --- WebView2 SDK files next to the program; loose page files from older builds are removed.
foreach ($f in $sdkFiles) { Copy-Item (Join-Path $wv2 $f) $dist -Force }
foreach ($f in $pageFiles + 'ReadMe.html') { Remove-Item (Join-Path $dist $f) -Force -ErrorAction SilentlyContinue }
$libDst = Join-Path $dist 'lib'
if (Test-Path $libDst) { Remove-Item $libDst -Recurse -Force }
Write-Host "Built $dist\$exeName and $contentName, signed by $($cert.Subject) ($($cert.Thumbprint))"

# --- Setup.exe for installing on any PC (Setup.cs): the signed program and the files installed with it as
# resources, listed with their SHA-256 in payload.sha256, and the whole file signed with the same certificate.
# Not included: check-source.ps1 and the project record (they belong to the PC that builds the program).
$release = Join-Path $here 'release'
New-Item -ItemType Directory -Force $release | Out-Null
$version = (Get-Item (Join-Path $dist $exeName)).VersionInfo.ProductVersion
if ($version -notmatch '^\d+(\.\d+){1,3}$') { throw "Unexpected program version '$version'." }
$payload = @(@($exeName, $contentName, 'MarkdownViewer.ico') + $sdkFiles | ForEach-Object { Join-Path $dist $_ }) +
           @('uninstall.ps1', 'firewall.ps1', 'trust.ps1', 'register.ps1' | ForEach-Object { Join-Path $here $_ })
$manifest = Join-Path $release 'payload.sha256'
[IO.File]::WriteAllLines($manifest, [string[]]@($payload | ForEach-Object { "$(Split-Path $_ -Leaf)=$((Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash)" }))
$setupInfo = Join-Path $release 'SetupBuild.cs'
[IO.File]::WriteAllText($setupInfo, @"
// Generated by build.ps1.
[assembly: System.Reflection.AssemblyVersion("$version.0")]
[assembly: System.Reflection.AssemblyFileVersion("$version.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("$version")]
static class SetupBuild { public const string Version = "$version"; }
"@)
foreach ($oldSetup in @(Get-ChildItem -LiteralPath $release -Filter 'MarkdownViewer-Setup-*.exe')) { [IO.File]::Delete($oldSetup.FullName) }
$setupExe = Join-Path $release "MarkdownViewer-Setup-$version.exe"
$rspLines = @('/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', "/out:`"$setupExe`"", "/win32icon:`"$ico`"",
              '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
              "/resource:`"$manifest`",payload.sha256", "/resource:`"$(Join-Path $srcDir 'favicon_readme.png')`",logo.png") +
            @($payload | ForEach-Object { "/resource:`"$_`",payload/$(Split-Path $_ -Leaf)" }) +
            @("`"$(Join-Path $here 'Setup.cs')`"", "`"$setupInfo`"")
$rsp = Join-Path $release 'setup.rsp'
[IO.File]::WriteAllLines($rsp, [string[]]$rspLines)
& $csc "@$rsp"
$code = $LASTEXITCODE
foreach ($tmp in $rsp, $manifest, $setupInfo) { if (Test-Path -LiteralPath $tmp) { [IO.File]::Delete($tmp) } }
if ($code -ne 0) { throw "Compiling Setup failed ($code)." }
Set-AuthenticodeSignature -FilePath $setupExe -Certificate $cert -HashAlgorithm SHA256 | Out-Null
$sig = Get-AuthenticodeSignature $setupExe
if (-not $sig.SignerCertificate -or $sig.SignerCertificate.Thumbprint -ne $cert.Thumbprint) { throw "Signing Setup failed ($($sig.StatusMessage))." }
Write-Host "Built $setupExe (installs the program on any PC), signed by the same certificate"
