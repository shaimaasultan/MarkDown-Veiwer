# Windows Firewall rules that block all network traffic in and out of the installed
# MarkdownViewerWebView2.exe. Needs administrator rights (asks for them with a UAC prompt).
#   firewall.ps1           add the two block rules (incoming + outgoing)
#   firewall.ps1 -Remove   remove them
# The app needs no network access, so the rules change nothing in how it works. They do not cover the
# WebView2 engine (msedgewebview2.exe), which Windows shares with other apps.
param([switch]$Remove, [string]$Exe, [string]$Log)
# Run with administrator rights, PowerShell would otherwise look for commands such as New-NetFirewallRule
# in the user's own module folder (Documents) first: a look-alike module there would run as administrator.
# Only Windows PowerShell's own modules, from its system folder (set before any command is used).
$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$group = 'Markdown Viewer (WebView2)'
if (-not $Exe) {
    # The installed program: in Program Files (Install-ProgramFiles.cmd) or for this user only.
    $Exe = Join-Path $env:ProgramFiles 'MarkdownViewerWebView2\MarkdownViewerWebView2.exe'
    if (-not (Test-Path $Exe)) { $Exe = Join-Path $env:LOCALAPPDATA 'Programs\MarkdownViewerWebView2\MarkdownViewerWebView2.exe' }
}
if (-not $Log) { $Log = Join-Path $env:TEMP 'MarkdownViewerWebView2-firewall.log' }

function Say($text) { Write-Host $text; Add-Content -Path $Log -Value $text -Encoding UTF8 }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    # Run again with administrator rights. The program path and log file are passed on, so they stay
    # this user's even if Windows asks for a different administrator account.
    Set-Content -Path $Log -Value "$(Get-Date -Format s)  $(if ($Remove) { 'remove' } else { 'add' }) block rules" -Encoding UTF8
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Exe', "`"$Exe`"", '-Log', "`"$Log`"")
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
