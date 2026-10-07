# Writes test\million-rows.csv: 1,000,000 rows (Id, Name, City, Amount, Date), about 45 MB - for trying the
# table view with a large file (open it in the viewer: right-click > Open with, or drop it on the window).
# The file is not kept in git (.gitignore); run this again to recreate it. Test-Viewer.cmd skips it (over 4 MB).
param([ValidateRange(1, 1100000)][int]$Rows = 1000000)
# Only Windows PowerShell's own modules (set before any command is used).
$env:PSModulePath = $PSHOME + '\Modules'
$ErrorActionPreference = 'Stop'
$out = Join-Path $PSScriptRoot 'million-rows.csv'
$cities = 'Toronto', 'Ottawa', 'Montréal', 'Calgary', 'Vancouver', 'Halifax', 'Winnipeg', 'Regina'
$inv = [Globalization.CultureInfo]::InvariantCulture
$w = New-Object IO.StreamWriter($out, $false, (New-Object Text.UTF8Encoding $false), 1MB)
try {
    $w.Write("Id,Name,City,Amount,Date`n")
    for ($i = 1; $i -le $Rows; $i++) {
        $amount = (($i * 7919) % 100000) / 100
        $w.Write([string]::Format($inv, "{0},Person {0},{1},{2},2026-{3:00}-{4:00}`n", $i, $cities[$i % 8], $amount, 1 + $i % 12, 1 + $i % 28))
    }
} finally { $w.Dispose() }
"Wrote $out ($Rows rows, {0:N1} MB)." -f ((Get-Item $out).Length / 1MB)
