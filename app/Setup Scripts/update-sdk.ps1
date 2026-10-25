# Updates the three WebView2 SDK DLLs in app\Setup Scripts\webview2\ from nuget.org (Microsoft.Web.WebView2).
#   update-sdk.ps1                        plan only: current and new version, the exact download, what changes
#   update-sdk.ps1 -Version 1.0.4314.35   a specific version instead of the latest stable one
#   update-sdk.ps1 ... -Apply             download, check and replace the files (asks first)
#   update-sdk.ps1 ... -Apply -Yes        the same without the question (when already confirmed)
#   update-sdk.ps1 ... -AllowNew          also take a release published less than 7 days ago
#
# A release younger than 7 days is held back: a package pushed through a hijacked account is usually found and
# withdrawn within days, and the SHA-512 check alone cannot tell (it comes from the same site).
#
# What it does with -Apply:
# - downloads the package (.nupkg) over HTTPS from api.nuget.org only - no redirects, a size limit;
# - checks it against the SHA-512 nuget.org publishes for that version (its catalog entry);
# - takes only lib\net462\Microsoft.Web.WebView2.Core.dll, lib\net462\Microsoft.Web.WebView2.WinForms.dll,
#   runtimes\win-x64\native\WebView2Loader.dll and LICENSE.txt out of it (never anything else) into a new, empty
#   folder of its own, and checks there that each DLL carries Microsoft's valid signature and is that version;
# - only if all three pass: replaces them in app\Setup Scripts\webview2\ (with the licence), puts their SHA-256 into
#   $sdkHashes in build.ps1 and the version into build.ps1's comment and the README's table.
# It never builds, signs or installs: run Install.cmd next (it lists the changed files and asks for Y; the build
# checks the new pins and signatures again). Undo with git:
#   git checkout -- "app/Setup Scripts/webview2" "app/Setup Scripts/build.ps1" README.md
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$Apply,
    [switch]$Yes,
    [switch]$AllowNew
)
# Only Windows PowerShell's own modules (set before any command is used).
$env:PSModulePath = $PSHOME + '\Modules'
$ErrorActionPreference = 'Stop'
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$uac = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).EnableLUA -ne 0
if ($elevated -and $uac) { Write-Host 'Run this from a normal window, not as administrator.'; exit 2 }

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$wv2 = Join-Path $PSScriptRoot 'webview2'
$buildScript = Join-Path $PSScriptRoot 'build.ps1'
$readme = Join-Path $root 'README.md'
$nuget = 'api.nuget.org'
$package = 'microsoft.web.webview2'
$maxPackage = 60MB
$minAgeDays = 7
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Where each file comes from in the package, and its name in app\Setup Scripts\webview2\.
$files = [ordered]@{
    'Microsoft.Web.WebView2.Core.dll'     = 'lib/net462/Microsoft.Web.WebView2.Core.dll'
    'Microsoft.Web.WebView2.WinForms.dll' = 'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
    'WebView2Loader.dll'                  = 'runtimes/win-x64/native/WebView2Loader.dll'
}
$licence = @{ From = 'LICENSE.txt'; To = 'WebView2-SDK-LICENSE.txt' }

# One HTTPS GET to nuget.org; returns the response bytes, or $null.
function Invoke-NuGet([string]$url, [int]$maxBytes) {
    try {
        $uri = [Uri]$url
        if ($uri.Scheme -ne 'https' -or $uri.Host -ne $nuget) { return $null }
        $req = [Net.HttpWebRequest]::Create($uri)
        $req.Method = 'GET'
        $req.AllowAutoRedirect = $false
        $req.Timeout = 30000; $req.ReadWriteTimeout = 60000
        $req.UserAgent = 'MarkdownViewerWebView2-update-sdk'
        $resp = $req.GetResponse()
        try {
            if ([int]$resp.StatusCode -ne 200 -or $resp.ResponseUri.Host -ne $nuget) { return $null }
            $stream = $resp.GetResponseStream(); $buffer = New-Object IO.MemoryStream; $chunk = New-Object byte[] 65536
            while (($n = $stream.Read($chunk, 0, $chunk.Length)) -gt 0) { $buffer.Write($chunk, 0, $n); if ($buffer.Length -gt $maxBytes) { return $null } }
            , $buffer.ToArray()
        } finally { $resp.Close() }
    } catch { $null }
}
function Get-NuGetJson([string]$url) {
    $bytes = Invoke-NuGet $url 8MB
    if ($bytes) { [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json } else { $null }
}
function Test-Version([string]$v) { $v -match '^\d{1,6}(\.\d{1,9}){1,3}$' }
function ConvertTo-Utc($stamp) {
    if ($stamp -is [datetime]) { return $stamp.ToUniversalTime() }
    $d = [datetime]::MinValue
    if ($stamp -and [datetime]::TryParse([string]$stamp, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]'AdjustToUniversal, AssumeUniversal', [ref]$d)) { return $d }
    $null
}

# --- The plan
$versions = @(@(foreach ($f in $files.Keys) { (Get-Item -LiteralPath (Join-Path $wv2 $f)).VersionInfo.FileVersion }) | Select-Object -Unique)
if ($versions.Count -ne 1) { Write-Host "The SDK files in $wv2 have different versions: $($versions -join ', ')." -ForegroundColor Yellow; exit 2 }
$current = $versions[0]
$target = $Version
if (-not $target) {
    $index = Get-NuGetJson "https://$nuget/v3-flatcontainer/$package/index.json"
    $stable = @($index.versions | Where-Object { $_ -is [string] -and (Test-Version $_) } | Sort-Object { [version]$_ })
    if ($stable.Count) { $target = $stable[-1] }
}
if (-not (Test-Version $target)) { Write-Host 'Could not find the WebView2 SDK version on nuget.org (no connection?).' -ForegroundColor Yellow; exit 2 }
$registration = Get-NuGetJson "https://$nuget/v3/registration5-semver1/$package/$target.json"
if (-not $registration) { Write-Host "nuget.org has no Microsoft.Web.WebView2 $target." -ForegroundColor Yellow; exit 2 }
$catalog = Get-NuGetJson ([string]$registration.catalogEntry)
$content = [string]$registration.packageContent
$published = ConvertTo-Utc $catalog.published
$needed = [bool]$Version -or ([version]$target -gt [version]$current)
$held = $needed -and -not $AllowNew -and (-not $published -or ([datetime]::UtcNow - $published).TotalDays -lt $minAgeDays)

Write-Host ''
Write-Host ("WebView2 SDK  {0,-28} from nuget.org 'Microsoft.Web.WebView2'" -f $(if ($needed) { "$current -> $target" } else { "$current (up to date)" }))
if ($held) {
    $when = if ($published) { "published $($published.ToLocalTime().ToString('yyyy-MM-dd')), less than $minAgeDays days ago" } else { 'publish date unknown' }
    Write-Host "              held back: $when. Try again later, or add -AllowNew to take it now." -ForegroundColor Yellow
}
if ($needed -and -not $held) {
    Write-Host ("              download: {0} ({1:N1} MB)" -f $content, ($catalog.packageSize / 1MB))
    Write-Host ("              replaces: {0}" -f (($files.Keys + $licence.To | ForEach-Object { "app\Setup Scripts\webview2\$_" }) -join ', '))
    Write-Host  '              updates:  the SHA-256 pins in app\Setup Scripts\build.ps1, the version in its comment and in README.md'
}
if (-not $needed -or $held) { Write-Host "`nNothing to update."; exit 0 }
if (-not $Apply) { Write-Host "`nPlan only - nothing was downloaded. Add -Apply to download and replace these files (it asks first)."; exit 0 }

if (-not $Yes -and ([Console]::IsInputRedirected -or $Host.Name -ne 'ConsoleHost')) { Write-Host 'This window cannot answer the question. Run Update-WebView2-SDK.cmd by double-clicking it.'; exit 2 }
if (-not $Yes -and (Read-Host "`nDownload and replace the WebView2 SDK files? [Y/N]").Trim() -notmatch '^(y|yes)$') { Write-Host 'Nothing was changed.'; exit 1 }

# --- Download and check
if ($catalog.packageHashAlgorithm -ne 'SHA512' -or -not $catalog.packageHash) { Write-Host 'nuget.org gives no SHA-512 for this version - nothing was changed.' -ForegroundColor Red; exit 1 }
$nupkg = Invoke-NuGet $content $maxPackage
if (-not $nupkg) { Write-Host 'Download failed (or larger than the limit) - nothing was changed.' -ForegroundColor Red; exit 1 }
if ([Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($nupkg)) -ne $catalog.packageHash) {
    Write-Host 'The download does not match the SHA-512 nuget.org publishes - nothing was changed.' -ForegroundColor Red; exit 1
}
Write-Host "`ndownloaded $([Math]::Round($nupkg.Length / 1MB, 1)) MB, SHA-512 matches nuget.org"

# Only the expected entries leave the package, into a new, empty folder of this run (removed afterwards).
Add-Type -AssemblyName System.IO.Compression
$stage = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ('Temp\mdv-sdk-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $zip = New-Object IO.Compression.ZipArchive((New-Object IO.MemoryStream(, $nupkg)), [IO.Compression.ZipArchiveMode]::Read)
    try {
        $wanted = @{}; foreach ($k in $files.Keys) { $wanted[$files[$k]] = $k }; $wanted[$licence.From] = $licence.To
        foreach ($entry in $zip.Entries) {
            if (-not $wanted.ContainsKey($entry.FullName)) { continue }
            $out = [IO.File]::Open((Join-Path $stage $wanted[$entry.FullName]), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $in = $entry.Open(); try { $in.CopyTo($out) } finally { $in.Dispose() } } finally { $out.Dispose() }
        }
    } finally { $zip.Dispose() }

    # Every DLL: present, Microsoft's valid signature, and really this version.
    $problems = @()
    foreach ($f in $files.Keys) {
        $p = Join-Path $stage $f
        if (-not (Test-Path -LiteralPath $p)) { $problems += "$f is not in the package ($($files[$f]))"; continue }
        $sig = Get-AuthenticodeSignature -LiteralPath $p
        if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') { $problems += "$f does not carry a valid Microsoft signature ($($sig.Status))" }
        $fileVersion = (Get-Item -LiteralPath $p).VersionInfo.FileVersion
        if ($fileVersion -ne $target) { $problems += "$f is version $fileVersion, not $target" }
    }
    if ($problems.Count) {
        Write-Host 'Not replaced:' -ForegroundColor Red
        $problems | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        exit 1
    }
    Write-Host "all three DLLs carry Microsoft's valid signature and are version $target"

    # --- Replace the files and the pins
    $hashes = [ordered]@{}
    foreach ($f in $files.Keys) {
        Copy-Item -LiteralPath (Join-Path $stage $f) -Destination (Join-Path $wv2 $f) -Force
        $hashes[$f] = (Get-FileHash -LiteralPath (Join-Path $wv2 $f) -Algorithm SHA256).Hash
    }
    if (Test-Path -LiteralPath (Join-Path $stage $licence.To)) { Copy-Item -LiteralPath (Join-Path $stage $licence.To) -Destination (Join-Path $wv2 $licence.To) -Force }

    $build = [IO.File]::ReadAllText($buildScript)
    foreach ($f in $hashes.Keys) {
        $pattern = "('" + [regex]::Escape($f) + "'\s*=\s*')[0-9A-F]{64}(')"
        if (-not [regex]::IsMatch($build, $pattern)) { throw "build.ps1 has no SHA-256 pin for $f; update `$sdkHashes by hand." }
        $build = [regex]::Replace($build, $pattern, "`${1}$($hashes[$f])`${2}")
    }
    $build = [regex]::Replace($build, '\(SDK \d{1,6}(\.\d{1,9}){1,3}\)', "(SDK $target)")
    [IO.File]::WriteAllText($buildScript, $build, (New-Object Text.UTF8Encoding $false))
    $text = [IO.File]::ReadAllText($readme)
    $text = [regex]::Replace($text, '(?m)^(\| Microsoft WebView2 SDK \| )[^|]+( \|)', "`${1}$target`${2}")
    [IO.File]::WriteAllText($readme, $text, (New-Object Text.UTF8Encoding $false))
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "`nUpdated the WebView2 SDK: $current -> $target" -ForegroundColor Green
Write-Host '  replaced the three DLLs and the licence in app\Setup Scripts\webview2\, the SHA-256 pins in build.ps1 and the version in README.md'
Write-Host 'Next: run Install.cmd (it lists the changed files and asks for Y; the build checks the new pins and signatures),'
Write-Host 'then Check-Updates.cmd so the reminder clears.'
Write-Host 'Undo with: git checkout -- "app/Setup Scripts/webview2" "app/Setup Scripts/build.ps1" README.md'
exit 0
