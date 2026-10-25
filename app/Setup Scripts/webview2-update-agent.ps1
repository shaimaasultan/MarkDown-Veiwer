$env:PSModulePath = $PSHOME + '\Modules'
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$state = 'unknown'
$current = $env:MDV_WEBVIEW2_CURRENT
$latest = ''
$checked = [DateTime]::UtcNow.ToString('o')
try {
    if ($current -notmatch '^\d{1,6}(\.\d{1,9}){1,3}$') { throw 'Invalid local SDK version.' }
    $url = 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/index.json'
    $uri = [Uri]$url
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'api.nuget.org') { throw 'Unexpected update host.' }
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.Method = 'GET'
    $request.AllowAutoRedirect = $false
    $request.Timeout = 15000
    $request.ReadWriteTimeout = 15000
    $request.Accept = 'application/json'
    $request.UserAgent = 'MarkdownViewerWebView2-update-check'
    $response = $request.GetResponse()
    try {
        if ([int]$response.StatusCode -ne 200 -or $response.ResponseUri.Host -ne 'api.nuget.org') { throw 'Unexpected update response.' }
        $stream = $response.GetResponseStream()
        $buffer = New-Object IO.MemoryStream
        $chunk = New-Object byte[] 65536
        while (($n = $stream.Read($chunk, 0, $chunk.Length)) -gt 0) {
            $buffer.Write($chunk, 0, $n)
            if ($buffer.Length -gt 1MB) { throw 'Update response exceeds the size limit.' }
        }
        $index = [Text.Encoding]::UTF8.GetString($buffer.ToArray()) | ConvertFrom-Json
    } finally { $response.Close() }
    $versions = @($index.versions | Where-Object { $_ -is [string] -and $_ -match '^\d{1,6}(\.\d{1,9}){1,3}$' } | Sort-Object { [version]$_ })
    if (-not $versions.Count) { throw 'No stable SDK version was returned.' }
    $latest = $versions[-1]
    $state = if ([version]$latest -gt [version]$current) { 'available' } else { 'current' }
} catch { $state = 'unknown' }

$path = $env:MDV_WEBVIEW2_STATUS
if (-not [IO.Path]::IsPathRooted($path)) { exit 2 }
$directory = [IO.Path]::GetDirectoryName($path)
[IO.Directory]::CreateDirectory($directory) | Out-Null
$temp = $path + '.' + [Guid]::NewGuid().ToString('N') + '.new'
$text = "checked=$checked`r`nstate=$state`r`ncurrent=$current`r`nlatest=$latest`r`n"
$bytes = [Text.Encoding]::UTF8.GetBytes($text)
try {
    $file = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    if ([IO.File]::Exists($path)) { [IO.File]::Replace($temp, $path, $null) }
    else { [IO.File]::Move($temp, $path) }
} finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
