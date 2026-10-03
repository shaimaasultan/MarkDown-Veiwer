# Builds Markdown Viewer with the C# compiler that ships with Windows (.NET Framework 4).
#   build.ps1           online edition  -> .\dist\MarkdownViewer.exe (libraries load from the internet)
#   build.ps1 -Offline  offline edition -> .\dist-offline\MarkdownViewerOffline.exe (libraries bundled in lib\)
#   build.ps1 -WebView2 WebView2 edition -> .\dist-webview2\MarkdownViewerWebView2.exe (bundled libraries, own window,
#                       no network port; needs the WebView2 SDK files in ..\webview2)
# Output goes to the dist folder together with the viewer files it serves.
param([switch]$Offline, [switch]$WebView2)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path $here -Parent
$bundled = $Offline -or $WebView2          # libraries bundled in lib\ (no internet needed)
$dist = Join-Path $here $(if ($WebView2) { 'dist-webview2' } elseif ($Offline) { 'dist-offline' } else { 'dist' })
$exeName = if ($WebView2) { 'MarkdownViewerWebView2.exe' } elseif ($Offline) { 'MarkdownViewerOffline.exe' } else { 'MarkdownViewer.exe' }
$wv2 = Join-Path $root 'webview2'          # Microsoft.Web.WebView2 SDK files (Core, WinForms, WebView2Loader)
New-Item -ItemType Directory -Force $dist | Out-Null

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'C# compiler (csc.exe) from .NET Framework 4 was not found.' }

# --- App icon: favicon_readme.png scaled to 256/48/32/16 and packed into an .ico (PNG entries).
Add-Type -AssemblyName System.Drawing
$ico = Join-Path $dist 'MarkdownViewer.ico'
$src = [System.Drawing.Image]::FromFile((Join-Path $root 'favicon_readme.png'))
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

# --- Compile
$cscArgs = @('/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
             "/out:$(Join-Path $dist $exeName)", "/win32icon:$ico",
             '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Core.dll', '/r:Microsoft.CSharp.dll')
if ($Offline) { $cscArgs += '/define:OFFLINE' }
if ($WebView2) {
    foreach ($f in 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll') {
        if (-not (Test-Path (Join-Path $wv2 $f))) { throw "WebView2 SDK file missing: $wv2\$f" }
    }
    $cscArgs = $cscArgs -replace '^/platform:anycpu$', '/platform:x64'     # WebView2Loader.dll is the x64 build
    $cscArgs += '/define:WEBVIEW2'
    $cscArgs += "/r:$(Join-Path $wv2 'Microsoft.Web.WebView2.Core.dll')"
    $cscArgs += "/r:$(Join-Path $wv2 'Microsoft.Web.WebView2.WinForms.dll')"
    $cscArgs += '/r:System.Management.dll'
}
$cscArgs += (Join-Path $here 'MarkdownViewer.cs')
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "Compilation failed ($LASTEXITCODE)." }

# --- Viewer files served by the exe
foreach ($f in 'ReadMe.html', 'viewer.js', 'marked.min.js', 'favicon_readme.png') {
    Copy-Item (Join-Path $root $f) $dist -Force
}

if ($WebView2) {
    # --- WebView2 SDK files next to the program
    foreach ($f in 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll') { Copy-Item (Join-Path $wv2 $f) $dist -Force }
}

if ($bundled) {
    # --- Bundled libraries (downloaded once into ..\offline\lib)
    $libSrc = Join-Path $root 'offline\lib'
    if (-not (Test-Path $libSrc)) { throw "Bundled libraries not found in $libSrc." }
    $libDst = Join-Path $dist 'lib'
    if (Test-Path $libDst) { Remove-Item $libDst -Recurse -Force }
    Copy-Item $libSrc $libDst -Recurse -Force

    # --- Offline copy of the viewer page: every library from ./lib/, no internet addresses at all.
    $page = Join-Path $dist 'ReadMe.html'
    $html = [IO.File]::ReadAllText($page, [Text.Encoding]::UTF8)
    $libs = @(
        @{ Name = 'KaTeX';        Re = 'https://cdn\.jsdelivr\.net/npm/katex@([\d.]+)/dist/';                Local = './lib/katex/' },
        @{ Name = 'highlight.js'; Re = 'https://cdnjs\.cloudflare\.com/ajax/libs/highlight\.js/([\d.]+)/'; Local = './lib/highlight/' },
        @{ Name = 'Mermaid';      Re = 'https://cdn\.jsdelivr\.net/npm/mermaid@([\d.]+)/dist/';              Local = './lib/mermaid/' }
    )
    $meta = @()
    foreach ($l in $libs) {
        $m = [regex]::Match($html, $l.Re)
        if (-not $m.Success) { throw "The page no longer loads $($l.Name) from its usual address; update build.ps1." }
        $meta += "$($l.Name)=$($m.Groups[1].Value)"
        $meta += "$($l.Name)-source=$($m.Value)"
        $html = [regex]::Replace($html, $l.Re, $l.Local)
    }
    # The bundled files must be the same versions the online page uses.
    foreach ($l in $libs) {
        $want = ($meta | Where-Object { $_ -like "$($l.Name)=*" }) -replace '^[^=]+=', ''
        $file = switch ($l.Name) { 'KaTeX' { 'katex\katex.min.js' } 'highlight.js' { 'highlight\highlight.min.js' } 'Mermaid' { 'mermaid\mermaid.min.js' } }
        $text = [IO.File]::ReadAllText((Join-Path $libDst $file))
        if (-not $text.Contains($want)) { throw "Bundled $($l.Name) is not version $want - download that version into offline\lib." }
    }
    $html = $html -replace ' https://cdn\.jsdelivr\.net', '' -replace ' https://cdnjs\.cloudflare\.com', ''
    # Nothing the page loads may point to the internet (checked before the 'original download' labels are added).
    if ($html -match 'https?://cdn') { throw 'An internet address is still left in the offline page.' }
    $editionName = if ($WebView2) { 'webview2' } else { 'offline' }
    $html = $html.Replace('<meta name="mdv-edition" content="online">',
        '<meta name="mdv-edition" content="' + $editionName + '">' + "`n" + '  <meta name="mdv-lib-versions" content="' + ($meta -join ';') + '">')
    $html = $html.Replace('<title>Markdown Folder Viewer</title>', "<title>Markdown Folder Viewer ($(if ($WebView2) { 'WebView2' } else { 'Offline' }))</title>")
    [IO.File]::WriteAllText($page, $html, (New-Object Text.UTF8Encoding $false))
    Write-Host "Offline page: libraries from ./lib/ ($($meta.Where({ $_ -notlike '*-source=*' }) -join ', ')), no internet addresses."
}
Write-Host "Built $dist\$exeName"
