# Updates the bundled libraries (marked, KaTeX, highlight.js, Mermaid) in src\ from the npm registry.
#   update-libs.ps1                          plan only: what would change, with the exact download sizes
#   update-libs.ps1 -Library highlight.js    plan for one library (or several: -Library KaTeX, Mermaid)
#   update-libs.ps1 -Library KaTeX -Version 0.19.0     a specific version instead of the latest
#   update-libs.ps1 ... -Apply               download, check and replace the files (asks first)
#   update-libs.ps1 ... -Apply -Yes          the same without the question (when already confirmed)
#
# What it does with -Apply, per library:
# - downloads the package (.tgz) over HTTPS from registry.npmjs.org only - no redirects, a size limit;
# - checks it against the SHA-512 the registry publishes for that version (dist.integrity);
# - takes only the expected files out of it (never anything else, never outside src\) and checks that each
#   really is the new version (the same check build.ps1 makes);
# - only if every expected file is there: replaces them in src\ and updates the version in viewer.js and in
#   the README's table. A library whose new release lacks an expected file (e.g. no ready-made browser file)
#   is left untouched, with an explanation.
# It never builds, signs or installs: test the documents, then run Install.cmd (it lists the changed files
# and asks for Y). Undo a library with git: git checkout -- src README.md
[CmdletBinding()]
param(
    [ValidateSet('marked', 'KaTeX', 'highlight.js', 'Mermaid')][string[]]$Library = @('marked', 'KaTeX', 'highlight.js', 'Mermaid'),
    [string]$Version,
    [switch]$Apply,
    [switch]$Yes
)
# Only Windows PowerShell's own modules (set before any command is used).
$env:PSModulePath = $PSHOME + '\Modules'
$ErrorActionPreference = 'Stop'
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$uac = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).EnableLUA -ne 0
if ($elevated -and $uac) { Write-Host 'Run this from a normal window, not as administrator.'; exit 2 }
if ($Version -and $Library.Count -ne 1) { Write-Host '-Version needs exactly one -Library.'; exit 2 }

$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'src'
$registry = 'registry.npmjs.org'
$maxPackage = 60MB
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Where each library's files come from (npm package, path inside it) and go (under src\). '*' = every
# matching file in that folder, which replaces the folder's previous files of that kind.
$libs = [ordered]@{
    'marked'       = @{ Package = 'marked';                  Files = @(, @('package/marked.min.js', 'marked.min.js')) }
    'KaTeX'        = @{ Package = 'katex';                   Files = @(@('package/dist/katex.min.js', 'lib\katex\katex.min.js'),
                                                                       @('package/dist/katex.min.css', 'lib\katex\katex.min.css'),
                                                                       @('package/dist/contrib/auto-render.min.js', 'lib\katex\contrib\auto-render.min.js'),
                                                                       @('package/dist/fonts/*.woff2', 'lib\katex\fonts\*.woff2')) }
    'highlight.js' = @{ Package = '@highlightjs/cdn-assets'; Files = @(@('package/highlight.min.js', 'lib\highlight\highlight.min.js'),
                                                                       @('package/styles/github.min.css', 'lib\highlight\styles\github.min.css'),
                                                                       @('package/styles/github-dark.min.css', 'lib\highlight\styles\github-dark.min.css')) }
    'Mermaid'      = @{ Package = 'mermaid';                 Files = @(, @('package/dist/mermaid.min.js', 'lib\mermaid\mermaid.min.js')) }
}

# One HTTPS GET to the registry; returns the response bytes, or $null.
function Invoke-Registry([string]$url, [int]$maxBytes) {
    try {
        $uri = [Uri]$url
        if ($uri.Scheme -ne 'https' -or $uri.Host -ne $registry) { return $null }
        $req = [Net.HttpWebRequest]::Create($uri)
        $req.Method = 'GET'
        $req.AllowAutoRedirect = $false
        $req.Timeout = 30000; $req.ReadWriteTimeout = 30000
        $req.UserAgent = 'MarkdownViewerWebView2-update-libs'
        $resp = $req.GetResponse()
        try {
            if ([int]$resp.StatusCode -ne 200 -or $resp.ResponseUri.Host -ne $registry) { return $null }
            $stream = $resp.GetResponseStream(); $buffer = New-Object IO.MemoryStream; $chunk = New-Object byte[] 65536
            while (($n = $stream.Read($chunk, 0, $chunk.Length)) -gt 0) { $buffer.Write($chunk, 0, $n); if ($buffer.Length -gt $maxBytes) { return $null } }
            , $buffer.ToArray()
        } finally { $resp.Close() }
    } catch { $null }
}
function Get-RegistryJson([string]$path) {
    $bytes = Invoke-Registry "https://$registry/$path" 8MB
    if ($bytes) { [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json } else { $null }
}
function Test-Version([string]$v) { $v -match '^\d{1,6}(\.\d{1,9}){1,3}$' }

# The files inside a .tgz, as name -> bytes (only those wanted). Reads the tar format directly: no program
# is started and nothing is written while reading.
function Read-Tgz([byte[]]$tgz, [scriptblock]$wanted) {
    $gz = New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(, $tgz)), [IO.Compression.CompressionMode]::Decompress)
    $tar = New-Object IO.MemoryStream; $gz.CopyTo($tar); $gz.Dispose()
    $data = $tar.ToArray(); $files = @{}; $pos = 0; $longName = $null
    while ($pos + 512 -le $data.Length) {
        if ($data[$pos] -eq 0) { break }                                                              # end of archive
        $name = [Text.Encoding]::UTF8.GetString($data, $pos, 100).TrimEnd([char]0)
        $prefix = [Text.Encoding]::UTF8.GetString($data, $pos + 345, 155).TrimEnd([char]0)
        if ($prefix) { $name = "$prefix/$name" }
        $sizeText = [Text.Encoding]::ASCII.GetString($data, $pos + 124, 12).Trim([char]0, ' ')
        $size = if ($sizeText) { [Convert]::ToInt64($sizeText, 8) } else { 0 }
        $type = [char]$data[$pos + 156]
        $bodyStart = $pos + 512
        if ($type -eq 'x' -or $type -eq 'L') {                                                       # long name for the next entry
            $text = [Text.Encoding]::UTF8.GetString($data, $bodyStart, [int]$size)
            $m = [regex]::Match($text, '(?m)^\d+ path=(.+)$')
            $longName = if ($type -eq 'L') { $text.TrimEnd([char]0) } elseif ($m.Success) { $m.Groups[1].Value } else { $null }
        } else {
            if ($longName) { $name = $longName; $longName = $null }
            if (($type -eq '0' -or $type -eq [char]0) -and (& $wanted $name)) {
                $body = New-Object byte[] $size; [Array]::Copy($data, $bodyStart, $body, 0, $size); $files[$name] = $body
            }
        }
        $pos = $bodyStart + [int]([Math]::Ceiling($size / 512.0) * 512)
    }
    $files
}

$viewerJs = Join-Path $src 'viewer.js'
$js = [IO.File]::ReadAllText($viewerJs)
$plans = foreach ($name in $libs.Keys | Where-Object { $Library -contains $_ }) {
    $lib = $libs[$name]
    $current = [regex]::Match($js, "name: '$([regex]::Escape($name))', version: '([^']+)'").Groups[1].Value
    $encoded = $lib.Package.Replace('/', '%2F')
    $target = if ($Version) { $Version } else { (Get-RegistryJson "$encoded/latest").version }
    if (-not (Test-Version $target)) { Write-Host "$name - could not find the version on npm (no connection?)." -ForegroundColor Yellow; continue }
    $meta = Get-RegistryJson "$encoded/$target"
    $tarball = $meta.dist.tarball; $integrity = $meta.dist.integrity
    $size = $meta.dist.unpackedSize    # the registry's figure; the download itself is compressed and smaller
    [pscustomobject]@{ Name = $name; Package = $lib.Package; Current = $current; Target = $target; Tarball = $tarball
                       Integrity = $integrity; Size = $size; Files = $lib.Files
                       Needed = ([version]$target -gt [version]$current) -or [bool]$Version }
}

Write-Host ''
foreach ($p in $plans) {
    $state = if (-not $p.Needed) { 'up to date' } else { "$($p.Current) -> $($p.Target)" }
    Write-Host ("{0,-13} {1,-22} from npm '{2}'" -f $p.Name, $state, $p.Package)
    if ($p.Needed) {
        Write-Host ("              download: {0} (package {1:N1} MB unpacked; the download is smaller)" -f $p.Tarball, ($p.Size / 1MB))
        Write-Host ("              replaces: {0}" -f (($p.Files | ForEach-Object { 'src\' + $_[1] }) -join ', '))
    }
}
$todo = @($plans | Where-Object Needed)
if (-not $todo.Count) { Write-Host "`nNothing to update."; exit 0 }
if (-not $Apply) { Write-Host "`nPlan only - nothing was downloaded. Add -Apply to download and replace these files (it asks first)."; exit 0 }

if (-not $Yes -and ([Console]::IsInputRedirected -or $Host.Name -ne 'ConsoleHost')) { Write-Host 'This window cannot answer the question. Run Update-Libraries.cmd by double-clicking it.'; exit 2 }
if (-not $Yes -and (Read-Host "`nDownload and replace these files? [Y/N]").Trim() -notmatch '^(y|yes)$') { Write-Host 'Nothing was changed.'; exit 1 }

$readme = Join-Path $root 'README.md'
$sha512 = [Security.Cryptography.SHA512]::Create()
$done = @()
foreach ($p in $todo) {
    Write-Host "`n$($p.Name) $($p.Target):"
    if (-not $p.Integrity -or $p.Integrity -notmatch '^sha512-') { Write-Host '  the registry gives no SHA-512 for this version - skipped.' -ForegroundColor Yellow; continue }
    $tgz = Invoke-Registry $p.Tarball $maxPackage
    if (-not $tgz) { Write-Host '  download failed (or larger than the limit) - skipped.' -ForegroundColor Yellow; continue }
    if ('sha512-' + [Convert]::ToBase64String($sha512.ComputeHash($tgz)) -ne $p.Integrity) { Write-Host '  the download does not match the SHA-512 the registry publishes - skipped.' -ForegroundColor Red; continue }
    Write-Host "  downloaded $([Math]::Round($tgz.Length / 1MB, 1)) MB, SHA-512 matches the registry"

    $patterns = $p.Files | ForEach-Object { $_[0] }
    $entries = Read-Tgz $tgz { param($n) foreach ($pat in $patterns) { if ($n -like $pat) { return $true } }; $false }
    # Every expected file (and at least one font for a '*' pattern) must be there.
    $missing = @($patterns | Where-Object { $pat = $_; -not ($entries.Keys | Where-Object { $_ -like $pat }) })
    if ($missing.Count) {
        Write-Host "  this release does not contain: $($missing -join ', ')" -ForegroundColor Yellow
        Write-Host '  It probably ships its browser file differently now, so the viewer would need code changes. Left untouched.'
        continue
    }
    # The main file must really be this version (as build.ps1 checks).
    $main = [Text.Encoding]::UTF8.GetString($entries[$p.Files[0][0]])
    if (-not $main.Contains('"' + $p.Target + '"') -and -not $main.Contains('v' + $p.Target)) {
        Write-Host "  $($p.Files[0][0]) does not name version $($p.Target), so the build would refuse it - left untouched." -ForegroundColor Yellow
        continue
    }
    # Replace the files under src\ (a '*' pattern replaces that folder's files of that kind).
    foreach ($f in $p.Files) {
        $dest = Join-Path $src $f[1]
        if ($f[0].Contains('*')) {
            $dir = Split-Path $dest -Parent; $kind = Split-Path $dest -Leaf
            Get-ChildItem -LiteralPath $dir -Filter $kind -File | Remove-Item
            foreach ($k in $entries.Keys | Where-Object { $_ -like $f[0] }) {
                $leaf = [IO.Path]::GetFileName($k)
                if ($leaf -notmatch '^[A-Za-z0-9_.-]+$') { continue }
                [IO.File]::WriteAllBytes((Join-Path $dir $leaf), $entries[$k])
            }
        } else {
            New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
            [IO.File]::WriteAllBytes($dest, $entries[$f[0]])
        }
    }
    $js = [regex]::Replace($js, "(name: '$([regex]::Escape($p.Name))', version: ')[^']+(')", "`${1}$($p.Target)`${2}")
    [IO.File]::WriteAllText($viewerJs, $js, (New-Object Text.UTF8Encoding $false))
    $text = [IO.File]::ReadAllText($readme)
    $text = [regex]::Replace($text, "(?m)^(\| $([regex]::Escape($p.Name)) \| )[^|]+( \|)", "`${1}$($p.Target)`${2}")
    [IO.File]::WriteAllText($readme, $text, (New-Object Text.UTF8Encoding $false))
    Write-Host "  replaced $($p.Files.Count) item(s) in src\, version updated in viewer.js and README.md" -ForegroundColor Green
    $done += "$($p.Name) $($p.Current) -> $($p.Target)"
}

Write-Host ''
if ($done.Count) {
    Write-Host "Updated: $($done -join '; ')"
    Write-Host 'Next: open a few documents that use them (math, diagrams, code, tables) in a test build or after'
    Write-Host 'Install.cmd, which lists the changed files and asks for Y. Undo with: git checkout -- src README.md'
} else { Write-Host 'Nothing was changed.' }
exit 0
