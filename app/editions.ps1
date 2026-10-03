# Names and paths of the Markdown Viewer editions.
# Dot-sourced by install.ps1, uninstall.ps1 and firewall.ps1 so they always agree.
#   online   - math, code colouring and diagrams load from the internet (Edge app window + local server)
#   offline  - every library is bundled (Edge app window + local server)
#   webview2 - every library is bundled; own window with the WebView2 control, no network port at all
function Get-MdvEdition([string]$Kind) {
    switch ($Kind) {
        'offline'  { $key = 'MarkdownViewerOffline';  $name = 'Markdown Viewer (Offline)';  $dist = 'dist-offline' }
        'webview2' { $key = 'MarkdownViewerWebView2'; $name = 'Markdown Viewer (WebView2)'; $dist = 'dist-webview2' }
        default    { $Kind = 'online'; $key = 'MarkdownViewer'; $name = 'Markdown Viewer'; $dist = 'dist' }
    }
    [pscustomobject]@{
        Kind           = $Kind
        Offline        = $Kind -ne 'online'                      # libraries bundled in lib\
        WebView2       = $Kind -eq 'webview2'
        Name           = $name                                   # shown in Start menu, Settings > Apps, Open with
        Key            = $key                                    # folder / registry key name
        Exe            = "$key.exe"
        Process        = $key
        ProgId         = "$key.md"
        Dist           = $dist
        InstallDir     = Join-Path $env:LOCALAPPDATA "Programs\$key"
        SettingsDir    = Join-Path $env:APPDATA $key
        DataDir        = Join-Path $env:LOCALAPPDATA $key        # WebView2 browser data (WebView2 edition)
        BackupKey      = "HKCU:\Software\$key"
        UninstallKey   = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$key"
        FirewallGroup  = $name
        FirewallAdd    = $(switch ($Kind) { 'offline' { 'Firewall-Add-Offline.cmd' } 'webview2' { '' } default { 'Firewall-Add.cmd' } })
        FirewallRemove = $(switch ($Kind) { 'offline' { 'Firewall-Remove-Offline.cmd' } 'webview2' { '' } default { 'Firewall-Remove.cmd' } })
    }
}

# Turn the scripts' -Offline / -WebView2 switches into an edition name.
function Get-MdvKind([bool]$Offline, [bool]$WebView2) {
    if ($WebView2) { 'webview2' } elseif ($Offline) { 'offline' } else { 'online' }
}
