# Checks that the project folder still holds exactly the source that was installed.
#   check-source.ps1                compare the project folder with the record made at the last install
#   check-source.ps1 -Root <folder> the same for that project folder
#   check-source.ps1 -Write <file>  make a record of the project folder (install.ps1 does this)
#   check-source.ps1 -Record <file> compare with that record instead of the installed one
#   -Quiet                          no output, only the exit code: 0 no changes, 1 changes, 2 no record
# Install.cmd installs the record (source-manifest.txt) and a copy of this script in Program Files, where
# only an administrator can change them, and Check-Source.cmd runs that installed copy - so a program
# running as you can neither change the record nor make the checker say "No changes".
# The record lists the SHA-256 of every file in the project folder except .git\ and the build output
# (app\dist\); links (junctions, symbolic links) are not followed.
param([string]$Write, [string]$Record, [string]$Root, [switch]$Quiet)
# Only Windows PowerShell's own modules (a look-alike Get-FileHash could otherwise report what it likes).
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$key = 'MarkdownViewerWebView2'
$installDir = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) $key
if (-not $Record) { $Record = Join-Path $installDir 'source-manifest.txt' }
function Say($text, $color) { if (-not $Quiet) { if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text } } }

# Every file under the project folder, by path relative to it.
function Get-SourceFiles($root) {
    $list = New-Object System.Collections.Generic.List[string]
    $dirs = New-Object System.Collections.Generic.Stack[string]
    $dirs.Push($root)
    while ($dirs.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $dirs.Pop() -Force) {
            $rel = $item.FullName.Substring($root.Length + 1)
            if ($rel -eq '.git' -or $rel -eq 'app\dist') { continue }
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $list.Add($rel + '  (link - not followed)'); continue }
            if ($item.PSIsContainer) { $dirs.Push($item.FullName) } else { $list.Add($rel) }
        }
    }
    $list | Sort-Object
}

function Get-Hashes($root) {
    $h = [ordered]@{}
    foreach ($rel in Get-SourceFiles $root) {
        $h[$rel] = if ($rel -like '*(link - not followed)') { 'LINK' } else { (Get-FileHash -LiteralPath (Join-Path $root $rel) -Algorithm SHA256).Hash }
    }
    $h
}

# The commit the folder is on, read from .git directly (no git program is started).
function Get-Commit($root) {
    $git = Join-Path $root '.git'
    $head = Join-Path $git 'HEAD'
    if (-not (Test-Path $head)) { return 'none' }
    $ref = (Get-Content $head -TotalCount 1).Trim()
    if ($ref -notlike 'ref: *') { return $ref }
    $name = $ref.Substring(5)
    $file = Join-Path $git $name
    if (Test-Path $file) { return (Get-Content $file -TotalCount 1).Trim() }
    $packed = Join-Path $git 'packed-refs'
    if (Test-Path $packed) { $line = Get-Content $packed | Where-Object { $_ -like "* $name" } | Select-Object -First 1; if ($line) { return $line.Split(' ')[0] } }
    'unknown'
}

if ($Write) {
    $root = if ($Root) { (Resolve-Path -LiteralPath $Root).Path } else { Split-Path $PSScriptRoot -Parent }
    $m = [regex]::Match([IO.File]::ReadAllText((Join-Path $root "app\$key.cs")), 'AppVersion = "([^"]+)"')
    $version = if ($m.Success) { $m.Groups[1].Value } else { '?' }
    $lines = @("# Markdown Viewer (WebView2) - project files at install time",
               "# installed $(Get-Date -Format s)  version $version  commit $(Get-Commit $root)",
               "# folder $root")
    $hashes = Get-Hashes $root
    foreach ($rel in $hashes.Keys) { $lines += "$($hashes[$rel])`t$rel" }
    [IO.File]::WriteAllLines($Write, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
    Say "Recorded $($hashes.Count) project files."
    exit 0
}

if (-not (Test-Path -LiteralPath $Record)) {
    Say "No record found at $Record - install the app with Install.cmd first." Yellow
    exit 2
}
$then = [ordered]@{}; $header = @(); $folder = $null
foreach ($line in Get-Content -LiteralPath $Record -Encoding UTF8) {
    if ($line.StartsWith('# folder ')) { $folder = $line.Substring(9) }
    if ($line.StartsWith('#')) { $header += $line.Substring(2); continue }
    $parts = $line.Split("`t", 2)
    if ($parts.Count -eq 2) { $then[$parts[1]] = $parts[0] }
}
# The project folder: as given, else the one recorded at install, else the folder this script is in.
$root = if ($Root) { $Root } elseif ($folder) { $folder } else { Split-Path $PSScriptRoot -Parent }
if (-not (Test-Path -LiteralPath $root)) { Say "Project folder not found: $root" Yellow; exit 2 }
$root = (Resolve-Path -LiteralPath $root).Path
$now = Get-Hashes $root
$changed = @($then.Keys | Where-Object { $now.Contains($_) -and $now[$_] -ne $then[$_] })
$removed = @($then.Keys | Where-Object { -not $now.Contains($_) })
$added   = @($now.Keys | Where-Object { -not $then.Contains($_) })

Say "Project folder: $root"
Say "Record:         $Record"
$header | Select-Object -Skip 1 | ForEach-Object { Say "                $_" }
Say "Checker:        $PSCommandPath"
Say "Commit now:     $(Get-Commit $root)"
Say ''
if (-not ($changed.Count + $removed.Count + $added.Count)) {
    Say "No changes: all $($then.Count) files are exactly as they were at the last install." Green
    exit 0
}
foreach ($set in @(@('Changed', $changed), @('Added', $added), @('Removed', $removed))) {
    if ($set[1].Count) {
        Say "$($set[0]) since the last install ($($set[1].Count)):" Yellow
        $set[1] | ForEach-Object { Say "  $_" }
    }
}
Say ''
Say 'If you did not make these changes yourself (or pull them with git), find out what did before installing again.'
exit 1
