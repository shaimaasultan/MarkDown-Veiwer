# Windows Firewall rules that block all network traffic in and out of the installed
# MarkdownViewerWebView2.exe. Needs administrator rights (asks for them with a UAC prompt).
#   firewall.ps1           add the two block rules (incoming + outgoing)
#   firewall.ps1 -Remove   remove them
# The app needs no network access, so the rules change nothing in how it works. They do not cover the
# WebView2 engine (msedgewebview2.exe), which Windows shares with other apps.
[CmdletBinding()]   # unknown parameters (e.g. a program path) are refused, never silently ignored
param([switch]$Remove)
# Run with administrator rights, PowerShell would otherwise look for commands such as New-NetFirewallRule
# in the user's own module folder (Documents) first: a look-alike module there would run as administrator.
# Only Windows PowerShell's own modules, from its system folder (set before any command is used).
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$group = 'Markdown Viewer (WebView2)'
# The program the rules are for: always the copy installed in Program Files, worked out here (also in the
# administrator step) from Windows' own record of that folder. No path is taken from outside, so nothing can
# get a rule made for some other program.
$Exe = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'MarkdownViewerWebView2\MarkdownViewerWebView2.exe'

# Results are shown in the administrator window itself: no log file, so no file in the user's folders can be
# made to point this administrator step at a system file.
function Say($text) { Write-Host $text }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    # Run again with administrator rights - always the copy installed in Program Files, which only an
    # administrator can change, never this file if it sits elsewhere (e.g. the project folder, where another
    # program could swap it between the UAC prompt and its start). Only -Remove is passed on; the
    # administrator step works out the program path itself.
    $installed = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'MarkdownViewerWebView2\firewall.ps1'
    if (-not (Test-Path -LiteralPath $installed)) { Write-Host 'Install the app first (Install.cmd): the firewall rules are set by its installed copy.'; exit 1 }
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$installed`"")
    if ($Remove) { $argList += '-Remove' }
    # Windows PowerShell by its full path, not whichever powershell.exe comes first on PATH.
    $psExe = Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell\v1.0\powershell.exe'
    try { $p = Start-Process $psExe -Verb RunAs -ArgumentList $argList -PassThru -Wait }
    catch { Write-Host 'Administrator rights were not granted; nothing was changed.'; exit 1 }
    exit $p.ExitCode
}

try {
    Remove-NetFirewallRule -Group $group -ErrorAction SilentlyContinue
    if ($Remove) {
        Say 'Removed the Markdown Viewer (WebView2) block rules.'
    } else {
        if (-not (Test-Path $Exe)) { throw "Program not found: $Exe (install the app first)." }
        New-NetFirewallRule -DisplayName "$group - block incoming" -Group $group -Direction Inbound -Action Block `
            -Program $Exe -Profile Any -Description 'Markdown Viewer (WebView2) needs no network access.' | Out-Null
        New-NetFirewallRule -DisplayName "$group - block outgoing" -Group $group -Direction Outbound -Action Block `
            -Program $Exe -Profile Any -Description 'Markdown Viewer (WebView2) needs no network access.' | Out-Null
        Say "Added block rules (incoming + outgoing) for $Exe"
    }
    # Verify what is in place now.
    $rules = @(Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue)
    Say "Rules now in place: $($rules.Count)"
    foreach ($r in $rules) {
        $app = ($r | Get-NetFirewallApplicationFilter).Program
        Say "  $($r.DisplayName): $($r.Direction) $($r.Action), enabled=$($r.Enabled), program=$app"
    }
    $code = if ($Remove) { [int]($rules.Count -ne 0) } else { [int]($rules.Count -ne 2) }
} catch {
    Say "Failed: $($_.Exception.Message)"
    $code = 1
}
Write-Host ''
Read-Host 'Press Enter to close'
exit $code
