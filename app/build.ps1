# Builds Markdown Viewer (WebView2) with the C# compiler that ships with Windows (.NET Framework 4).
#   build.ps1  ->  .\dist\MarkdownViewerWebView2.exe, together with the page, the bundled libraries
#                  and Microsoft's WebView2 SDK files it needs.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path $here -Parent
$dist = Join-Path $here 'dist'
$exeName = 'MarkdownViewerWebView2.exe'
$wv2 = Join-Path $root 'webview2'          # Microsoft.Web.WebView2 SDK files (Core, WinForms, WebView2Loader)
$sdkFiles = 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'
New-Item -ItemType Directory -Force $dist | Out-Null

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw 'The 64-bit C# compiler (csc.exe) from .NET Framework 4 was not found.' }
foreach ($f in $sdkFiles) {
    if (-not (Test-Path (Join-Path $wv2 $f))) { throw "WebView2 SDK file missing: $wv2\$f" }
}
if (-not (Test-Path (Join-Path $root 'lib'))) { throw "Bundled libraries not found in $root\lib." }

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

# --- Compile (x64: WebView2Loader.dll is the x64 build)
$cscArgs = @('/nologo', '/target:winexe', '/optimize+', '/platform:x64',
             "/out:$(Join-Path $dist $exeName)", "/win32icon:$ico",
             '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Core.dll', '/r:Microsoft.CSharp.dll',
             '/r:System.Management.dll',
             "/r:$(Join-Path $wv2 'Microsoft.Web.WebView2.Core.dll')",
             "/r:$(Join-Path $wv2 'Microsoft.Web.WebView2.WinForms.dll')",
             (Join-Path $here 'MarkdownViewerWebView2.cs'))
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "Compilation failed ($LASTEXITCODE)." }

# --- Page files, bundled libraries and the WebView2 SDK files next to the program
foreach ($f in 'ReadMe.html', 'viewer.js', 'marked.min.js', 'favicon_readme.png') { Copy-Item (Join-Path $root $f) $dist -Force }
$libDst = Join-Path $dist 'lib'
if (Test-Path $libDst) { Remove-Item $libDst -Recurse -Force }
Copy-Item (Join-Path $root 'lib') $libDst -Recurse -Force
foreach ($f in $sdkFiles) { Copy-Item (Join-Path $wv2 $f) $dist -Force }

# The bundled library files must be the versions viewer.js lists (both About windows show those).
$js = [IO.File]::ReadAllText((Join-Path $root 'viewer.js'))
$files = @{ 'marked' = 'marked.min.js'; 'KaTeX' = 'lib\katex\katex.min.js'; 'highlight.js' = 'lib\highlight\highlight.min.js'; 'Mermaid' = 'lib\mermaid\mermaid.min.js' }
foreach ($lib in $files.Keys) {
    $m = [regex]::Match($js, "name: '$([regex]::Escape($lib))', version: '([^']+)'")
    if (-not $m.Success) { throw "viewer.js does not list a version for $lib." }
    $text = [IO.File]::ReadAllText((Join-Path $root $files[$lib]))
    if (-not $text.Contains('"' + $m.Groups[1].Value + '"') -and -not $text.Contains('v' + $m.Groups[1].Value)) {
        throw "$($files[$lib]) is not $lib $($m.Groups[1].Value) as listed in viewer.js."
    }
}

# Nothing the page loads may point to the internet.
$page = [IO.File]::ReadAllText((Join-Path $dist 'ReadMe.html'))
if ($page -match '(?:src|href)="https?:') { throw 'The page loads something from the internet; every library must come from lib\.' }
Write-Host "Built $dist\$exeName"
