# Checks that this project folder still holds exactly the source that was installed.
#   check-source.ps1               compare the folder with the record made at the last install
#   check-source.ps1 -Write <file> make that record (install.ps1 does this; the record is installed in
#                                  Program Files, where only an administrator can change it)
# The record lists the SHA-256 of every file in the project folder except .git\ and the build output
# (app\dist\). A change to any source, script, library or SDK file since the install shows up here - also one
# made by another program running as you, which cannot change the record itself.
param([string]$Write)
# Only Windows PowerShell's own modules (a look-alike Get-FileHash could otherwise report what it likes).
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$key = 'MarkdownViewerWebView2'
$recordName = 'source-manifest.txt'
$record = Join-Path (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) $key) $recordName

# Every file under the project folder, by path relative to it; links (junctions, symbolic links) are not
# followed, so only what really is in the folder counts.
function Get-SourceFiles {
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

function Get-Hashes {
    $h = [ordered]@{}
    foreach ($rel in Get-SourceFiles) {
        $h[$rel] = if ($rel -like '*(link - not followed)') { 'LINK' } else { (Get-FileHash -LiteralPath (Join-Path $root $rel) -Algorithm SHA256).Hash }
    }
    $h
}

# The commit the folder is on, read from .git directly (no git program is started).
function Get-Commit {
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
    $version = try { (Get-Item (Join-Path $root "app\dist\$key.exe")).VersionInfo.ProductVersion } catch { '?' }
    $lines = @("# Markdown Viewer (WebView2) - project files at install time",
               "# installed $(Get-Date -Format s)  version $version  commit $(Get-Commit)",
               "# folder $root")
    $hashes = Get-Hashes
    foreach ($rel in $hashes.Keys) { $lines += "$($hashes[$rel])`t$rel" }
    [IO.File]::WriteAllLines($Write, [string[]]$lines, (New-Object Text.UTF8Encoding $false))
    Write-Host "Recorded $($hashes.Count) project files."
    exit 0
}

if (-not (Test-Path $record)) {
    Write-Host "No record found at $record - install the app with Install.cmd first." -ForegroundColor Yellow
    exit 2
}
$then = [ordered]@{}; $header = @()
foreach ($line in Get-Content $record -Encoding UTF8) {
    if ($line.StartsWith('#')) { $header += $line.Substring(2); continue }
    $parts = $line.Split("`t", 2)
    if ($parts.Count -eq 2) { $then[$parts[1]] = $parts[0] }
}
$now = Get-Hashes
$changed = @($then.Keys | Where-Object { $now.Contains($_) -and $now[$_] -ne $then[$_] })
$removed = @($then.Keys | Where-Object { -not $now.Contains($_) })
$added   = @($now.Keys | Where-Object { -not $then.Contains($_) })

Write-Host "Project folder: $root"
Write-Host "Record:         $record"
$header | Select-Object -Skip 1 | ForEach-Object { Write-Host "                $_" }
$commitNow = Get-Commit
Write-Host "Commit now:     $commitNow"
Write-Host ''
if (-not ($changed.Count + $removed.Count + $added.Count)) {
    Write-Host "No changes: all $($then.Count) files are exactly as they were at the last install." -ForegroundColor Green
    exit 0
}
foreach ($set in @(@('Changed', $changed, 'Yellow'), @('Added', $added, 'Yellow'), @('Removed', $removed, 'Yellow'))) {
    if ($set[1].Count) {
        Write-Host "$($set[0]) since the last install ($($set[1].Count)):" -ForegroundColor $set[2]
        $set[1] | ForEach-Object { Write-Host "  $_" }
    }
}
Write-Host ''
Write-Host 'If you did not make these changes yourself (or pull them with git), find out what did before installing again.'
exit 1
