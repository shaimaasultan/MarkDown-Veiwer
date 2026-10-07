# Tests the viewer page in src\ with the documents in test\ (plus, optionally, every .md / .csv / .tsv in -Folder):
#   test-viewer.ps1                     test\*.md
#   test-viewer.ps1 -Folder ..\..\BAD   also the .md files in that folder
#
# For every document it checks that the page shows it, that the breakdown adds up (✓), and that nothing that
# could run code got into the page: no script/iframe/object/embed/form/base/meta elements, no on... attributes,
# no javascript: or data:text/html addresses, no input except disabled task-list checkboxes, and that none
# of test\attack.md's payloads ran (each would set window.PWN).
#
# How: copies src\ to a new temporary folder (under %LOCALAPPDATA%\Temp, removed afterwards), adds the test
# documents and test\selftest.js to that copy only, and opens it in Microsoft Edge without a window and with a
# new, empty profile. The copy is served by this script on 127.0.0.1 only, on a free port, under a random
# path; every other address is refused. Edge cannot look up any host name (only 127.0.0.1 is reachable). Nothing in src\ is changed,
# nothing is built, signed or installed. Exit code 0 = all passed, 1 = a check failed, 2 = could not run.
[CmdletBinding()]
param(
    [string]$Folder,
    [ValidateRange(30, 900)][int]$TimeoutSeconds = 180
)
# Only Windows PowerShell's own modules (set before any command is used).
$env:PSModulePath = $PSHOME + '\Modules'
$ErrorActionPreference = 'Stop'
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$uac = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction SilentlyContinue).EnableLUA -ne 0
if ($elevated -and $uac) { Write-Host 'Run this from a normal window, not as administrator.'; exit 2 }

$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'src'
$tests = Join-Path $root 'test'
$maxDoc = 4MB

# One command-line argument, quoted by Windows' rules (CommandLineToArgvW).
function ConvertTo-NativeArgument([string]$text) {
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $backslashes = 0
    foreach ($ch in $text.ToCharArray()) {
        if ($ch -eq '\') { $backslashes++; continue }
        if ($ch -eq '"') { [void]$sb.Append('\' * (2 * $backslashes + 1)).Append('"') }
        else { [void]$sb.Append('\' * $backslashes).Append($ch) }
        $backslashes = 0
    }
    [void]$sb.Append('\' * (2 * $backslashes)).Append('"')
    $sb.ToString()
}

# The documents: plain .md files only (no links), each at most 4 MB.
$docFiles = @(Get-ChildItem -LiteralPath $tests -File | Where-Object { $_.Extension -in '.md', '.csv', '.tsv' })
if ($Folder) {
    if (-not (Test-Path -LiteralPath $Folder -PathType Container)) { Write-Host "Folder not found: $Folder"; exit 2 }
    $docFiles += @(Get-ChildItem -LiteralPath $Folder -File | Where-Object { $_.Extension -in '.md', '.csv', '.tsv' })
}
$docFiles = @($docFiles | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $_.Length -le $maxDoc })
if (-not $docFiles.Count) { Write-Host 'No test documents found.'; exit 2 }

# Microsoft Edge, by its full path, with a valid Microsoft signature.
$edge = @(([Environment]::GetFolderPath('ProgramFilesX86')), ([Environment]::GetFolderPath('ProgramFiles'))) |
        ForEach-Object { Join-Path $_ 'Microsoft\Edge\Application\msedge.exe' } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $edge) { Write-Host 'Microsoft Edge was not found; it is needed to run the page.'; exit 2 }
$edgeSig = Get-AuthenticodeSignature -LiteralPath $edge
if ($edgeSig.Status -ne 'Valid' -or $edgeSig.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') {
    Write-Host "$edge does not carry a valid Microsoft signature; not started."; exit 2
}

# The temporary copy: src\ plus the test documents and the test script, in a new folder.
$rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
$tokenBytes = New-Object byte[] 16; $rng.GetBytes($tokenBytes)
$token = -join ($tokenBytes | ForEach-Object { $_.ToString('x2') })
$bed = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ("Temp\mdv-test-" + $token.Substring(0, 12))
$page = Join-Path $bed 'page'
$profileDir = Join-Path $bed 'profile'
New-Item -ItemType Directory -Path $bed | Out-Null
$edgeProc = $null
$listener = $null
try {
    Copy-Item -LiteralPath $src -Destination $page -Recurse
    Copy-Item -LiteralPath (Join-Path $tests 'selftest.js') -Destination (Join-Path $page 'selftest.js')
    $entries = foreach ($f in $docFiles) {
        $name = $f.Name.Replace('\', '').Replace('"', '')
        '  ["' + $name + '", "' + [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName)) + '"]'
    }
    [IO.File]::WriteAllText((Join-Path $page 'testdocs.js'), "window.TESTDOCS = [`n" + ($entries -join ",`n") + "`n];`n", (New-Object Text.UTF8Encoding $false))
    $htmlPath = Join-Path $page 'viewer.html'
    $html = [IO.File]::ReadAllText($htmlPath)
    $tag = '<script src="./viewer.js"></script>'
    if (-not $html.Contains($tag)) { Write-Host 'viewer.html does not load viewer.js as expected; cannot add the test.'; exit 2 }
    $html = $html.Replace($tag, '<script src="./testdocs.js"></script>' + $tag + '<script src="./selftest.js"></script>')
    # As in the app: the page's policy without file: (only the page's own server).
    $html = [regex]::Replace($html, '<meta http-equiv="Content-Security-Policy" content="[^"]*"', { param($m) $m.Value.Replace(' file:', '') })
    [IO.File]::WriteAllText($htmlPath, $html, (New-Object Text.UTF8Encoding $false))
    $pageRoot = [IO.Path]::GetFullPath($page).TrimEnd('\') + '\'

    # The local server: 127.0.0.1 only, a free port, everything under /<token>/.
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $url = "http://127.0.0.1:$port/$token/viewer.html"
    $types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
                '.woff2' = 'font/woff2'; '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.svg' = 'image/svg+xml'; '.json' = 'application/json' }

    $edgeArgs = @('--headless=new', "--user-data-dir=$profileDir", '--no-first-run', '--no-default-browser-check',
                  '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update',
                  '--no-pings', '--mute-audio', '--window-size=1280,900', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', $url)
    Write-Host "Testing $($docFiles.Count) document(s) in Microsoft Edge (no window)..."
    $edgeProc = Start-Process -FilePath $edge -ArgumentList (($edgeArgs | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ') -PassThru

    $result = $null
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $ascii = [Text.Encoding]::ASCII
    while (-not $result -and (Get-Date) -lt $deadline) {
        if (-not $listener.Pending()) { Start-Sleep -Milliseconds 20; continue }
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 5000; $client.SendTimeout = 5000
            $stream = $client.GetStream()
            # The request head (at most 16 KB).
            $head = New-Object IO.MemoryStream; $one = New-Object byte[] 1
            while ($head.Length -lt 16KB -and $stream.Read($one, 0, 1) -eq 1) {
                $head.WriteByte($one[0])
                if ($one[0] -eq 10 -and $head.Length -ge 4) {
                    $b = $head.GetBuffer(); $n = [int]$head.Length
                    if ($b[$n - 2] -eq 13 -and $b[$n - 3] -eq 10 -and $b[$n - 4] -eq 13) { break }
                }
            }
            $lines = $ascii.GetString($head.ToArray()) -split "`r`n"
            $first = $lines[0] -split ' '
            $method = $first[0]; $path = if ($first.Count -gt 1) { $first[1] } else { '' }
            $status = 404; $body = [byte[]]@(); $type = 'text/plain'
            $prefix = "/$token/"
            if ($path.StartsWith($prefix)) {
                $rel = [Uri]::UnescapeDataString($path.Substring($prefix.Length).Split('?')[0])
                if ($method -eq 'POST' -and $rel -eq 'result') {
                    $len = 0
                    foreach ($l in $lines) { if ($l -match '^Content-Length:\s*(\d{1,9})\s*$') { $len = [int]$Matches[1] } }
                    if ($len -gt 0 -and $len -le 8MB) {
                        $buf = New-Object byte[] $len; $got = 0
                        while ($got -lt $len) { $n = $stream.Read($buf, $got, $len - $got); if ($n -le 0) { break }; $got += $n }
                        if ($got -eq $len) { $result = [Text.Encoding]::UTF8.GetString($buf); $status = 204 }
                    }
                } elseif ($method -eq 'GET' -and $rel -notmatch '\.\.|\\|:|^/') {
                    $file = [IO.Path]::GetFullPath((Join-Path $page $rel.Replace('/', '\')))
                    if ($file.StartsWith($pageRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $file -PathType Leaf)) {
                        $body = [IO.File]::ReadAllBytes($file); $status = 200
                        $ext = [IO.Path]::GetExtension($file).ToLowerInvariant()
                        $type = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
                    }
                }
            }
            $reason = @{ 200 = 'OK'; 204 = 'No Content'; 404 = 'Not Found' }[$status]
            $out = $ascii.GetBytes("HTTP/1.1 $status $reason`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`n" +
                                   "Cache-Control: no-store`r`nX-Content-Type-Options: nosniff`r`nConnection: close`r`n`r`n")
            $stream.Write($out, 0, $out.Length)
            if ($body.Length) { $stream.Write($body, 0, $body.Length) }
            $stream.Flush()
        } catch { } finally { $client.Close() }
    }
} finally {
    if ($listener) { $listener.Stop() }
    if ($edgeProc) {
        & (Join-Path ([Environment]::SystemDirectory) 'taskkill.exe') /PID $edgeProc.Id /T /F 2>&1 | Out-Null
    }
    for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $bed); $i++) {
        try { Remove-Item -LiteralPath $bed -Recurse -Force } catch { Start-Sleep -Milliseconds 250 }
    }
    if (Test-Path -LiteralPath $bed) { Write-Host "Could not remove the temporary folder $bed; delete it later." -ForegroundColor Yellow }
}

if (-not $result) { Write-Host "No result within $TimeoutSeconds seconds; the page did not finish." -ForegroundColor Red; exit 2 }
$r = $result | ConvertFrom-Json
if ($r.failed) { Write-Host "The test page stopped with an error: $($r.failed)" -ForegroundColor Red; exit 2 }

$failed = 0
Write-Host ''
foreach ($d in $r.results) {
    $problems = @()
    if (-not $d.rendered) { $problems += 'nothing shown' }
    if ($d.breakdown -ne 'ok') { $problems += "breakdown $($d.breakdown)" }
    if ($d.tableProblems -and @($d.tableProblems).Count) { $problems += "table: $(@($d.tableProblems) -join '; ')" }
    if ($d.drawn -lt $d.diagrams) { $problems += "$($d.diagrams - $d.drawn) diagram(s) not drawn" }
    if (@($d.badTags).Count) { $problems += "elements: $(@($d.badTags) -join ', ')" }
    if (@($d.onAttrs).Count) { $problems += "on... attributes on: $(@($d.onAttrs) -join ', ')" }
    if (@($d.badUrls).Count) { $problems += "code addresses on: $(@($d.badUrls) -join ', ')" }
    if ($d.otherInputs) { $problems += "$($d.otherInputs) input(s) other than disabled checkboxes" }
    if ($d.pwn) { $problems += "a payload ran: $($d.pwn)" }
    $v = $d.viewed
    $info = if ($v) { '{0} lines, {1} chars, {2} words' -f $v.lines, $v.chars, $v.words } else { 'table: drawn, sorted and filtered as expected' }
    if ($problems.Count) {
        $failed++
        Write-Host ("FAIL {0,-24} {1}" -f $d.name, ($problems -join '; ')) -ForegroundColor Red
    } else {
        Write-Host ("ok   {0,-24} {1}" -f $d.name, $info) -ForegroundColor Green
    }
}
if (@($r.pageErrors).Count) {
    $failed++
    Write-Host "FAIL page errors: $(@($r.pageErrors | Select-Object -First 5) -join ' | ')" -ForegroundColor Red
}
$notLoaded = @($r.libs | Where-Object { -not $_.loaded })
if ($notLoaded.Count) { $failed++; Write-Host "FAIL not loaded: $(($notLoaded | ForEach-Object { $_.name }) -join ', ')" -ForegroundColor Red }
if (@($r.libs).Count) { Write-Host "`nLibraries: $((@($r.libs) | ForEach-Object { "$($_.name) $($_.version)" }) -join ', ')" }
Write-Host ''
if ($failed) { Write-Host "$failed problem(s) found." -ForegroundColor Red; exit 1 }
Write-Host "All $(@($r.results).Count) document(s) passed." -ForegroundColor Green
exit 0
