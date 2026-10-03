# Removes one Markdown Viewer edition for the current user and restores previous .md defaults.
#   uninstall.ps1            online edition
#   uninstall.ps1 -Offline   offline edition
#   uninstall.ps1 -WebView2  WebView2 edition
# The other edition (if installed) is left untouched.
param([switch]$Offline, [switch]$WebView2)
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'editions.ps1')
$ed = Get-MdvEdition (Get-MdvKind $Offline.IsPresent $WebView2.IsPresent)
$dest = $ed.InstallDir
$progId = $ed.ProgId
$classes = 'HKCU:\Software\Classes'

Get-Process $ed.Process -ErrorAction SilentlyContinue | Stop-Process -Force

# Firewall rules (if they were added with the Firewall-Add script) need administrator rights to remove.
if ($ed.FirewallAdd -and (Get-NetFirewallRule -Group $ed.FirewallGroup -ErrorAction SilentlyContinue)) {
    $fw = Join-Path $PSScriptRoot 'firewall.ps1'
    if (Test-Path $fw) { & $fw -Remove -Offline:$Offline }
    else { Write-Host "$($ed.Name) firewall rules remain; remove them with $($ed.FirewallRemove)." }
}

foreach ($ext in '.md', '.markdown', '.mdown', '.mkd') {
    $extKey = "$classes\$ext"
    if (Test-Path "$extKey\OpenWithProgids") {
        Remove-ItemProperty "$extKey\OpenWithProgids" -Name $progId -ErrorAction SilentlyContinue
    }
    if ((Get-ItemProperty $extKey -ErrorAction SilentlyContinue).'(default)' -eq $progId) {
        $prev = (Get-ItemProperty $ed.BackupKey -ErrorAction SilentlyContinue)."Prev$ext"
        if ($prev) { Set-Item -Path $extKey -Value $prev }
        else { Remove-ItemProperty $extKey -Name '(default)' -ErrorAction SilentlyContinue }
    }
}
Remove-Item "$classes\$progId" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$classes\Applications\$($ed.Exe)" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $ed.BackupKey -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $ed.SettingsDir -Recurse -Force -ErrorAction SilentlyContinue   # saved view settings
if ($ed.WebView2) { Remove-Item $ed.DataDir -Recurse -Force -ErrorAction SilentlyContinue }   # WebView2 browser data
$programs = [Environment]::GetFolderPath('Programs')
Remove-Item (Join-Path $programs "$($ed.Name).lnk") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $programs "About $($ed.Name).lnk") -Force -ErrorAction SilentlyContinue
Remove-Item $ed.UninstallKey -Recurse -Force -ErrorAction SilentlyContinue

Add-Type -Namespace Win32 -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);' -ErrorAction SilentlyContinue
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

# The running script may live inside $dest, so delete the folder after this process exits.
Start-Process cmd.exe -WindowStyle Hidden -ArgumentList "/c timeout /t 2 >nul & rmdir /s /q `"$dest`""
Write-Host "$($ed.Name) was uninstalled."
