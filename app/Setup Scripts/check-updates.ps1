# Checks whether newer versions exist of what this project builds with: the WebView2 SDK (nuget.org) and the
# bundled libraries marked, KaTeX, highlight.js and Mermaid (npm registry). Also shows the WebView2 Runtime
# installed on this PC (read locally).
#   check-updates.ps1    exit code: 0 up to date, 1 updates available, 2 could not check everything
#
# This manual checker contacts these hosts only when you run it. The app also has a separate daily SDK-only check:
# - HTTPS only, to two fixed hosts (api.nuget.org, registry.npmjs.org); redirects are not followed;
# - every answer has a 15-second time limit and a size limit, and only a version number is taken from it;
# - nothing is downloaded or installed: the SDK files are pinned by SHA-256 in build.ps1, so an update is a
#   deliberate step (see README > Updating the WebView2 SDK and libraries).
# The result is remembered in %LOCALAPPDATA%\MarkdownViewerWebView2\update-check.txt, so Install.cmd can
# remind you when updates were found or the last check is more than 30 days old.
[CmdletBinding()]
param()
# Only Windows PowerShell's own modules (set before any command is used).
$env:PSModulePath = $PSHOME + '\Modules'
$ErrorActionPreference = 'Stop'
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$uac = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).EnableLUA -ne 0
if ($elevated -and $uac) { Write-Host 'Run this from a normal window, not as administrator.'; exit 2 }

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# One GET to a fixed HTTPS host; the parsed JSON, or $null.
function Get-Json([string]$url, [string]$expectedHost, [int]$maxBytes) {
    try {
        $uri = [Uri]$url
        if ($uri.Scheme -ne 'https' -or $uri.Host -ne $expectedHost) { return $null }
        $req = [Net.HttpWebRequest]::Create($uri)
        $req.Method = 'GET'
        $req.AllowAutoRedirect = $false
        $req.Timeout = 15000
        $req.ReadWriteTimeout = 15000
        $req.Accept = 'application/json'
        $req.UserAgent = 'MarkdownViewerWebView2-update-check'
        $resp = $req.GetResponse()
        try {
            if ([int]$resp.StatusCode -ne 200 -or $resp.ResponseUri.Host -ne $expectedHost) { return $null }
            $stream = $resp.GetResponseStream()
            $buffer = New-Object IO.MemoryStream
            $chunk = New-Object byte[] 65536
            while (($n = $stream.Read($chunk, 0, $chunk.Length)) -gt 0) {
                $buffer.Write($chunk, 0, $n)
                if ($buffer.Length -gt $maxBytes) { return $null }
            }
            [Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json
        } finally { $resp.Close() }
    } catch { $null }
}

function Test-Version([string]$v) { $v -match '^\d{1,6}(\.\d{1,9}){1,3}$' }

$rows = New-Object Collections.Generic.List[object]
function Add-Row($name, $current, $latest, $note) {
    $state = if (-not (Test-Version $latest)) { 'could not check' }
             elseif ([version]$latest -gt [version]$current) { 'UPDATE AVAILABLE' } else { 'up to date' }
    $rows.Add([pscustomobject]@{ Name = $name; Current = $current; Latest = $(if (Test-Version $latest) { $latest } else { '?' }); State = $state; Note = $note })
}

# The WebView2 SDK DLLs this project builds and ships (all three files must agree).
$sdkVersions = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll' |
    ForEach-Object { (Get-Item -LiteralPath (Join-Path $root "app\Setup Scripts\webview2\$_")).VersionInfo.FileVersion } | Select-Object -Unique)
if ($sdkVersions.Count -ne 1) { throw "The WebView2 SDK files in app\Setup Scripts\webview2\ have different versions: $($sdkVersions -join ', ')" }
$sdkFiles = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')
$index = Get-Json 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json' 'api.nuget.org' 1MB
$stable = @($index.versions | Where-Object { $_ -is [string] -and (Test-Version $_) } | Sort-Object { [version]$_ })
$sdkLatest = if ($stable.Count) { $stable[-1] } else { $null }
Add-Row 'WebView2 SDK DLLs (build input)' $sdkVersions[0] $sdkLatest 'A newer SDK means refresh the signed DLLs and rebuild the app'

# The bundled libraries, as listed in viewer.js (the build checks the files match these versions).
$js = [IO.File]::ReadAllText((Join-Path $root 'app\source\viewer.js'))
foreach ($lib in @(@('marked', 'marked'), @('KaTeX', 'katex'), @('highlight.js', 'highlight.js'), @('Mermaid', 'mermaid'))) {
    $m = [regex]::Match($js, "name: '$([regex]::Escape($lib[0]))', version: '([^']+)'")
    $latest = (Get-Json "https://registry.npmjs.org/$($lib[1])/latest" 'registry.npmjs.org' 4MB).version
    Add-Row $lib[0] $m.Groups[1].Value $latest "npm: $($lib[1])"
}

$rows | Format-Table Name, Current, Latest, State -AutoSize | Out-String -Width 120 | Write-Host

# Say explicitly whether this project needs new SDK DLLs, and whether its current build output has picked up
# the SDK DLLs already pinned in the project. The app and Setup do not update themselves.
$sdkState = $rows | Where-Object Name -eq 'WebView2 SDK DLLs (build input)' | Select-Object -First 1
if ($sdkState.State -eq 'UPDATE AVAILABLE') {
    Write-Host "WEBVIEW2 APP DLL UPDATE AVAILABLE: stable SDK $($sdkState.Latest) is newer than the project DLLs ($($sdkState.Current)). After reviewing the release, update the three signed files and SHA-256 pins, then rebuild and install." -ForegroundColor Yellow
} elseif ($sdkState.State -eq 'up to date') {
    Write-Host "WebView2 app SDK DLLs: project inputs are current at $($sdkState.Current)."
} else {
    Write-Host 'WebView2 app DLL update status could not be determined.' -ForegroundColor Yellow
}

$dist = Join-Path $root 'app\dist'
$buildNeedsRefresh = $false
$distMissing = @($sdkFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $dist $_) -PathType Leaf) })
if ($distMissing.Count) {
    $buildNeedsRefresh = $true
    Write-Host "Application build output is missing SDK DLLs (missing: $($distMissing -join ', ')); run Install.cmd or build.ps1 to build and copy the project SDK files." -ForegroundColor Yellow
} else {
    $distDiffers = @($sdkFiles | Where-Object {
        (Get-FileHash -LiteralPath (Join-Path $root "app\Setup Scripts\webview2\$_") -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath (Join-Path $dist $_) -Algorithm SHA256).Hash
    })
    if ($distDiffers.Count) {
        $buildNeedsRefresh = $true
        Write-Host "Application build output is stale for these WebView2 SDK DLLs: $($distDiffers -join ', '). Rebuild with Install.cmd or build.ps1 to pick them up." -ForegroundColor Yellow
    } else {
        Write-Host 'Application build output has picked up all three current project WebView2 SDK DLLs.' -ForegroundColor Green
    }
}

# The WebView2 Runtime on this PC (updated by Windows / Microsoft Edge Update, not by this project).
$runtime = foreach ($k in 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
                          'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') {
    (Get-ItemProperty $k -ErrorAction SilentlyContinue).pv }
$runtime = @($runtime | Where-Object { $_ }) | Select-Object -First 1
Write-Host "WebView2 Runtime on this PC: $(if ($runtime) { $runtime } else { 'not found' }) (kept up to date by Windows)"

$updates = @($rows | Where-Object State -eq 'UPDATE AVAILABLE')
if ($buildNeedsRefresh) { $updates += [pscustomobject]@{ Name = 'WebView2 application build output'; Current = 'stale'; Latest = $sdkVersions[0]; State = 'UPDATE AVAILABLE' } }
$failed = @($rows | Where-Object State -eq 'could not check')
Write-Host ''
if ($updates.Count) {
    Write-Host "$($updates.Count) update(s) available: $(($updates | ForEach-Object { "$($_.Name) $($_.Latest)" }) -join '; ')" -ForegroundColor Yellow
    Write-Host 'Nothing was downloaded. See README > Updating the WebView2 SDK and libraries for the steps.'
} elseif (-not $failed.Count) {
    Write-Host 'Everything is up to date.' -ForegroundColor Green
}
if ($failed.Count) { Write-Host "Could not check: $(($failed | ForEach-Object Name) -join ', ') (no internet connection, or the site answered unexpectedly)." -ForegroundColor Yellow }

# Remember the result for Install.cmd's reminder.
$stateDir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MarkdownViewerWebView2'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$webState = if ($sdkState.State -eq 'UPDATE AVAILABLE') { 'available' }
            elseif ($sdkState.State -eq 'could not check') { 'unknown' }
            elseif ($buildNeedsRefresh) { 'build-stale' }
            else { 'current' }
$statusPath = Join-Path $stateDir 'webview2-update-status.txt'
$statusTemp = $statusPath + '.' + [Guid]::NewGuid().ToString('N') + '.new'
$statusText = "checked=$([DateTime]::UtcNow.ToString('o'))`r`nstate=$webState`r`ncurrent=$($sdkState.Current)`r`nlatest=$($sdkState.Latest)`r`n"
try {
    $statusBytes = [Text.Encoding]::UTF8.GetBytes($statusText)
    $statusStream = [IO.File]::Open($statusTemp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $statusStream.Write($statusBytes, 0, $statusBytes.Length); $statusStream.Flush($true) } finally { $statusStream.Dispose() }
    if ([IO.File]::Exists($statusPath)) { [IO.File]::Replace($statusTemp, $statusPath, $null) }
    else { [IO.File]::Move($statusTemp, $statusPath) }
} finally { if ([IO.File]::Exists($statusTemp)) { [IO.File]::Delete($statusTemp) } }
$lines = @("checked=$((Get-Date).ToString('s'))", "complete=$(-not $failed.Count)") + @($updates | ForEach-Object { "update=$($_.Name) $($_.Current) -> $($_.Latest)" })
[IO.File]::WriteAllLines((Join-Path $stateDir 'update-check.txt'), [string[]]$lines)
exit $(if ($failed.Count) { 2 } elseif ($updates.Count) { 1 } else { 0 })
