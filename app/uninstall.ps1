# Removes Markdown Viewer (WebView2): the Program Files copy, any per-user copy from earlier versions, and this
# account's entries; restores the previous .md defaults. Run by Settings > Apps > Uninstall (from the copy
# in Program Files) or by Uninstall.cmd.
# - Entries are removed only when they belong to the installed copy (or point to a program that no longer
#   exists): file types, "Open with", shortcuts and the Settings > Apps entry of another copy are left alone.
# - One administrator prompt, for the firewall rules (if you added them) and the Program Files folder
#   together. It runs a short readable PowerShell command (what the UAC details show), never a script file.
# - The signing certificate stays in your certificate store (later builds reuse it).
# Only Windows PowerShell's own modules, from its system folder: a look-alike command in the user's module
# folder (Documents) could otherwise change what the UAC prompt below starts.
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Continue'
$name = 'Markdown Viewer (WebView2)'
$key = 'MarkdownViewerWebView2'
$progId = "$key.md"
$classes = 'HKCU:\Software\Classes'
$backupKey = "HKCU:\Software\$key"
$unKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$key"
# Folders as Windows records them, not from environment variables (which can be set per user).
$userDest = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "Programs\$key"   # earlier versions
$machineDest = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) $key
$dest = if (Test-Path -LiteralPath (Join-Path $machineDest "$key.exe")) { $machineDest } else { $userDest }
$exe = Join-Path $dest "$key.exe"
$system32 = [Environment]::SystemDirectory

function Quote($s) { "'" + $s.Replace("'", "''") + "'" }
function ConvertTo-NativeArgument([string]$text) {   # Windows' command-line quoting (CommandLineToArgvW)
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
# An entry is ours when the program it starts is the installed copy - or no longer exists.
function Test-Ours([string]$program) {
    if (-not $program) { return $true }
    $program = $program.Trim().Trim('"')
    ($program -ieq $exe) -or ($program -ieq (Join-Path $userDest "$key.exe")) -or -not (Test-Path -LiteralPath $program)
}
function Get-CommandProgram([string]$command) {
    if ($command -match '^\s*"([^"]+)"') { $Matches[1] } elseif ($command -match '^\s*(\S+)') { $Matches[1] } else { $null }
}

# Close the installed copy (any other copy is left running).
Get-Process $key -ErrorAction SilentlyContinue | Where-Object { Test-Ours $_.Path } | Stop-Process -Force -ErrorAction SilentlyContinue

# The signing certificate's trust, if it was added with Trust-Certificate.cmd.
$trust = Join-Path $PSScriptRoot 'trust.ps1'
if ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $trust)) {
    $thumb = (Get-AuthenticodeSignature $exe).SignerCertificate.Thumbprint
    if ($thumb -and (Get-ChildItem Cert:\CurrentUser\TrustedPublisher, Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $thumb)) {
        & $trust -Remove -Exe $exe
    }
}

# File types and "Open with" - only those that start the installed copy (or nothing that exists any more).
$kept = @()
foreach ($k in "$classes\$progId", "$classes\$key.media", "$classes\Applications\$key.exe") {
    if (-not (Test-Path $k)) { continue }
    $program = Get-CommandProgram (Get-ItemProperty "$k\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
    if (Test-Ours $program) { Remove-Item $k -Recurse -Force -ErrorAction SilentlyContinue } else { $kept += "$k -> $program" }
}
if (-not (Test-Path "$classes\$progId")) {
    foreach ($ext in '.md', '.markdown', '.mdown', '.mkd') {
        $extKey = "$classes\$ext"
        if (Test-Path "$extKey\OpenWithProgids") { Remove-ItemProperty "$extKey\OpenWithProgids" -Name $progId -ErrorAction SilentlyContinue }
        if ((Get-ItemProperty $extKey -ErrorAction SilentlyContinue).'(default)' -eq $progId) {
            $prev = (Get-ItemProperty $backupKey -ErrorAction SilentlyContinue)."Prev$ext"
            if ($prev) { Set-Item -Path $extKey -Value $prev }
            else { Remove-ItemProperty $extKey -Name '(default)' -ErrorAction SilentlyContinue }
        }
    }
    Remove-Item $backupKey -Recurse -Force -ErrorAction SilentlyContinue
}
if (-not (Test-Path "$classes\$key.media")) {
    foreach ($ext in '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.mp4', '.webm', '.mp3', '.wav', '.ogg') {
        if (Test-Path "$classes\$ext\OpenWithProgids") { Remove-ItemProperty "$classes\$ext\OpenWithProgids" -Name "$key.media" -ErrorAction SilentlyContinue }
    }
}

# Start menu shortcuts and the Settings > Apps entry - only those of the installed copy.
$shell = New-Object -ComObject WScript.Shell
$programs = [Environment]::GetFolderPath('Programs')
foreach ($link in (Join-Path $programs "$name.lnk"), (Join-Path $programs "About $name.lnk")) {
    if ((Test-Path -LiteralPath $link) -and (Test-Ours $shell.CreateShortcut($link).TargetPath)) { Remove-Item -LiteralPath $link -Force }
}
$entry = Get-ItemProperty $unKey -ErrorAction SilentlyContinue
if ($entry -and (-not $entry.InstallLocation -or $entry.InstallLocation.TrimEnd('\') -ieq $dest.TrimEnd('\') -or
                 -not (Test-Path -LiteralPath $entry.InstallLocation))) { Remove-Item $unKey -Recurse -Force }

Remove-Item (Join-Path ([Environment]::GetFolderPath('ApplicationData')) $key) -Recurse -Force -ErrorAction SilentlyContinue        # saved view settings
Remove-Item (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $key) -Recurse -Force -ErrorAction SilentlyContinue   # browser data, error log

Add-Type -Namespace Win32 -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);' -ErrorAction SilentlyContinue
[Win32.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

# Never sit inside a folder that is about to be removed.
Set-Location -LiteralPath $system32

# One administrator step for the firewall rules and the Program Files folder. It works the folder out itself.
$hasRules = [bool](Get-NetFirewallRule -Group $name -ErrorAction SilentlyContinue)
$hasFolder = Test-Path -LiteralPath $machineDest
$failed = $false
if ($hasRules -or $hasFolder) {
    $steps = @('$env:PSModulePath = $PSHOME + ''\Modules''', '$ErrorActionPreference = ''Stop''')
    if ($hasRules) { $steps += "Remove-NetFirewallRule -Group $(Quote $name) -ErrorAction SilentlyContinue" }
    if ($hasFolder) {
        $steps += "Set-Location -LiteralPath $(Quote $system32)"
        $steps += "`$dir = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) $(Quote $key)"
        $steps += 'if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }'
    }
    $argLine = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ' + (ConvertTo-NativeArgument ($steps -join '; '))
    $psExe = Join-Path $system32 'WindowsPowerShell\v1.0\powershell.exe'
    try {
        $p = Start-Process $psExe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList $argLine
        if ($p.ExitCode -ne 0) { Write-Host "Could not remove $machineDest (is the viewer still open?). Run Uninstall.cmd again."; $failed = $true }
    } catch {
        Write-Host "Administrator rights were not granted: $machineDest$(if ($hasRules) { ' and the firewall rules' }) remain. Run Uninstall.cmd again to finish."
        $failed = $true
    }
}

# A per-user copy from earlier versions needs no administrator rights.
if (Test-Path -LiteralPath $userDest) {
    try { Remove-Item -LiteralPath $userDest -Recurse -Force -ErrorAction Stop }
    catch { Start-Process (Join-Path $system32 'cmd.exe') -WindowStyle Hidden -ArgumentList "/c timeout /t 2 >nul & rmdir /s /q `"$userDest`"" }
}

if ($kept.Count) {
    Write-Host 'Left in place because they belong to another copy:'
    $kept | ForEach-Object { Write-Host "  $_" }
}
Write-Host "$name was uninstalled$(if ($failed) { ', except as noted above' })."
