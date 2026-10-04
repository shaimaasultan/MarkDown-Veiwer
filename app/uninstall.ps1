# Removes Markdown Viewer (WebView2) for the current user and restores the previous .md defaults.
$ErrorActionPreference = 'Continue'
$name = 'Markdown Viewer (WebView2)'
$key = 'MarkdownViewerWebView2'
$progId = "$key.md"
$userDest = Join-Path $env:LOCALAPPDATA "Programs\$key"
$machineDest = Join-Path $env:ProgramFiles $key
$machine = Test-Path (Join-Path $machineDest "$key.exe")
$dest = if ($machine) { $machineDest } else { $userDest }
$backupKey = "HKCU:\Software\$key"
$classes = 'HKCU:\Software\Classes'

Get-Process $key -ErrorAction SilentlyContinue | Stop-Process -Force

# Block rules (if added with Firewall-Block.cmd) need administrator rights to remove.
if (Get-NetFirewallRule -Group $name -ErrorAction SilentlyContinue) {
    $fw = Join-Path $PSScriptRoot 'firewall.ps1'
    if (Test-Path $fw) { & $fw -Remove -Exe (Join-Path $dest "$key.exe") }
    else { Write-Host "The $name firewall rules remain; remove them with Firewall-Unblock.cmd." }
}

# The signing certificate, if it was added to the trusted lists with Trust-Certificate.cmd.
$exePath = Join-Path $dest "$key.exe"
$trust = Join-Path $PSScriptRoot 'trust.ps1'
if ((Test-Path $exePath) -and (Test-Path $trust)) {
    $thumb = (Get-AuthenticodeSignature $exePath).SignerCertificate.Thumbprint
    if ($thumb -and (Get-ChildItem Cert:\CurrentUser\TrustedPublisher, Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $thumb)) {
        & $trust -Remove -Exe $exePath
    }
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
foreach ($ext in '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.mp4', '.webm', '.mp3', '.wav', '.ogg') {
    if (Test-Path "$classes\$ext\OpenWithProgids") {
        Remove-ItemProperty "$classes\$ext\OpenWithProgids" -Name "$key.media" -ErrorAction SilentlyContinue
    }
}
Remove-Item "$classes\$key.media" -Recurse -Force -ErrorAction SilentlyContinue
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

# The running script may live inside the program folder, so delete it after this process exits.
# A Program Files folder needs administrator rights to delete (one UAC prompt).
$rmdir = @{ FilePath = 'cmd.exe'; WindowStyle = 'Hidden' }
if (Test-Path $userDest) { Start-Process @rmdir -ArgumentList "/c timeout /t 2 >nul & rmdir /s /q `"$userDest`"" }
if ($machine) {
    try { Start-Process @rmdir -Verb RunAs -ArgumentList "/c timeout /t 2 >nul & rmdir /s /q `"$machineDest`"" }
    catch { Write-Host "Administrator rights were not granted: delete $machineDest yourself to finish." }
}
Write-Host "$name was uninstalled."
