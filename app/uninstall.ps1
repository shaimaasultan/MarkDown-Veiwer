# Removes Markdown Viewer (WebView2) for the current user and restores the previous .md defaults.
$ErrorActionPreference = 'Continue'
$name = 'Markdown Viewer (WebView2)'
$key = 'MarkdownViewerWebView2'
$progId = "$key.md"
$dest = Join-Path $env:LOCALAPPDATA "Programs\$key"
$backupKey = "HKCU:\Software\$key"
$classes = 'HKCU:\Software\Classes'

Get-Process $key -ErrorAction SilentlyContinue | Stop-Process -Force

# Block rules (if added with Firewall-Block.cmd) need administrator rights to remove.
if (Get-NetFirewallRule -Group $name -ErrorAction SilentlyContinue) {
    $fw = Join-Path $PSScriptRoot 'firewall.ps1'
    if (Test-Path $fw) { & $fw -Remove -Exe (Join-Path $dest "$key.exe") }
    else { Write-Host "The $name firewall rules remain; remove them with Firewall-Unblock.cmd." }
}

foreach ($ext in '.md', '.markdown', '.mdown', '.mkd') {
    $extKey = "$classes\$ext"
    if (Test-Path "$extKey\OpenWithProgids") {
        Remove-ItemProperty "$extKey\OpenWithProgids" -Name $progId -ErrorAction SilentlyContinue
    }
    if ((Get-ItemProperty $extKey -ErrorAction SilentlyContinue).'(default)' -eq $progId) {
        $prev = (Get-ItemProperty $backupKey -ErrorAction SilentlyContinue)."Prev$ext"
        if ($prev) { Set-Item -Path $extKey -Value $prev }
        else { Remove-ItemProperty $extKey -Name '(default)' -ErrorAction SilentlyContinue }
    }
}
Remove-Item "$classes\$progId" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$classes\Applications\$key.exe" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $backupKey -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:APPDATA $key) -Recurse -Force -ErrorAction SilentlyContinue        # saved view settings
Remove-Item (Join-Path $env:LOCALAPPDATA $key) -Recurse -Force -ErrorAction SilentlyContinue   # WebView2 browser data
$programs = [Environment]::GetFolderPath('Programs')
Remove-Item (Join-Path $programs "$name.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $programs "About $name.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$key" -Recurse -Force -ErrorAction SilentlyContinue

Add-Type -Namespace Win32 -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);' -ErrorAction SilentlyContinue
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

# The running script may live inside $dest, so delete the folder after this process exits.
Start-Process cmd.exe -WindowStyle Hidden -ArgumentList "/c timeout /t 2 >nul & rmdir /s /q `"$dest`""
Write-Host "$name was uninstalled."
