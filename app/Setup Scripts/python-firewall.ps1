$env:PSModulePath = "$PSHOME\Modules"
$ErrorActionPreference = 'Stop'
$mode = $env:MDV_PYTHON_FIREWALL_MODE
if ($mode -notin @('Create', 'Check', 'Remove')) { throw 'Run this through Python-Firewall.cmd; its source integrity check is required.' }
$Check = $mode -eq 'Check'
$Remove = $mode -eq 'Remove'
function Finish([int]$code) {
    [void](Read-Host 'Press Enter to close this window')
    exit $code
}
$group = 'Markdown Viewer - Python Network Block (manual)'
$allProfiles = 0x7FFFFFFF
if ($Check -and $Remove) { throw 'Choose either -Check or -Remove, not both.' }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Open an Administrator Command Prompt, then run Python-Firewall.cmd.' -ForegroundColor Yellow
    Write-Host 'This separate tool is not run by the Markdown Viewer installer.'
    Finish 2
}

function Find-TrustedPython([string]$name) {
    foreach ($entry in ($env:PATH -split [IO.Path]::PathSeparator)) {
        try {
            $dir = $entry.Trim().Trim('"')
            if (-not $dir -or $dir -match '(?i)\\WindowsApps(?:\\|$)') { continue }
            $candidate = [IO.Path]::GetFullPath([IO.Path]::Combine($dir, $name))
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            if (([IO.File]::GetAttributes($candidate) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            $signature = Get-AuthenticodeSignature -LiteralPath $candidate
            if ([string]$signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match '(?i)O=Python Software Foundation,') {
                return $candidate
            }
        } catch { }
    }
    return $null
}

function Get-ExpectedTargets {
    $items = @()
    foreach ($item in @(
        @{ Name = 'python.exe'; Rule = "$group - python.exe outbound" },
        @{ Name = 'py.exe'; Rule = "$group - py.exe outbound" }
    )) {
        $path = Find-TrustedPython $item.Name
        if ($path) { $items += [pscustomobject]@{ Name = $item.Name; Rule = $item.Rule; Path = $path } }
    }
    return $items
}

function Get-RuleErrors($rules, $target) {
    $errors = @()
    $matches = @()
    foreach ($rule in $rules) {
        try {
            if ($rule.Grouping -eq $group -and $rule.Name -eq $target.Rule) {
                $matches += [pscustomobject]@{
                    ApplicationName = $rule.ApplicationName
                    Direction = $rule.Direction
                    Action = $rule.Action
                    Profiles = $rule.Profiles
                    Enabled = $rule.Enabled
                    Protocol = $rule.Protocol
                    LocalAddresses = $rule.LocalAddresses
                    RemoteAddresses = $rule.RemoteAddresses
                    LocalPorts = $rule.LocalPorts
                    RemotePorts = $rule.RemotePorts
                    InterfaceTypes = $rule.InterfaceTypes
                }
            }
        } finally {
            if ([Runtime.InteropServices.Marshal]::IsComObject($rule)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($rule) }
        }
    }
    if ($matches.Count -ne 1) { return @("$($target.Name): expected one managed rule, found $($matches.Count)") }
    $rule = $matches[0]
    if (-not [string]::Equals([string]$rule.ApplicationName, $target.Path, [StringComparison]::OrdinalIgnoreCase)) { $errors += "$($target.Name): executable path does not match $($target.Path)" }
    if ([int]$rule.Direction -ne 2) { $errors += "$($target.Name): rule is not outbound" }
    if ([int]$rule.Action -ne 0) { $errors += "$($target.Name): rule is not a block" }
    if ([int]$rule.Profiles -ne $allProfiles) { $errors += "$($target.Name): rule does not cover all network profiles" }
    if (-not [bool]$rule.Enabled) { $errors += "$($target.Name): rule is disabled" }
    if ([int]$rule.Protocol -ne 256) { $errors += "$($target.Name): rule is limited to a protocol" }
    foreach ($scopeName in @('LocalAddresses', 'RemoteAddresses')) {
        if ([string]$rule.$scopeName -notin @('*', 'Any')) { $errors += "$($target.Name): rule is limited to an address scope" }
    }
    foreach ($scopeName in @('LocalPorts', 'RemotePorts')) {
        if ([string]$rule.$scopeName -notin @('', '*', 'Any')) { $errors += "$($target.Name): rule is limited to a port scope" }
    }
    if ([string]$rule.InterfaceTypes -ne 'All') { $errors += "$($target.Name): rule is limited to an interface type" }
    return $errors
}

# Verify the resultant policy too: COM exposes the local rule collection, while ActiveStore
# includes the policy Windows is currently applying after Group Policy and local policy merge.
function Get-ActiveRuleErrors($target) {
    $errors = @()
    try {
        $active = @(Get-NetFirewallRule -PolicyStore ActiveStore -Name $target.Rule -ErrorAction Stop)
        if ($active.Count -ne 1) { return @("$($target.Name): expected one effective ActiveStore rule, found $($active.Count)") }
        $rule = $active[0]
        if ([string]$rule.Enabled -ne 'True') { $errors += "$($target.Name): effective rule is disabled" }
        if ([string]$rule.Direction -ne 'Outbound') { $errors += "$($target.Name): effective rule is not outbound" }
        if ([string]$rule.Action -ne 'Block') { $errors += "$($target.Name): effective rule is not a block" }
        $profiles = @($rule.Profile | ForEach-Object { ([string]$_).Replace(' ', '') }) -join ','
        if ($profiles -notin @('Any', 'Domain,Private,Public', 'Domain,Public,Private', 'Private,Domain,Public', 'Private,Public,Domain', 'Public,Domain,Private', 'Public,Private,Domain')) {
            $errors += "$($target.Name): effective rule does not cover all profiles ($profiles)"
        }
        $appFilter = @($rule | Get-NetFirewallApplicationFilter -ErrorAction Stop)
        if ($appFilter.Count -ne 1 -or -not [string]::Equals([string]$appFilter[0].Program, $target.Path, [StringComparison]::OrdinalIgnoreCase)) {
            $errors += "$($target.Name): effective rule targets a different executable"
        }
        $portFilter = @($rule | Get-NetFirewallPortFilter -ErrorAction Stop)
        if ($portFilter.Count -ne 1 -or [string]$portFilter[0].Protocol -notin @('Any', '256') -or
            [string]$portFilter[0].LocalPort -notin @('Any', '') -or [string]$portFilter[0].RemotePort -notin @('Any', '')) {
            $errors += "$($target.Name): effective rule is limited by protocol or port"
        }
        $addressFilter = @($rule | Get-NetFirewallAddressFilter -ErrorAction Stop)
        if ($addressFilter.Count -ne 1 -or [string]$addressFilter[0].LocalAddress -notin @('Any', '*') -or
            [string]$addressFilter[0].RemoteAddress -notin @('Any', '*')) {
            $errors += "$($target.Name): effective rule is limited by address"
        }
        $interfaceFilter = @($rule | Get-NetFirewallInterfaceFilter -ErrorAction Stop)
        if ($interfaceFilter.Count -ne 1 -or [string]$interfaceFilter[0].InterfaceAlias -notin @('Any', '*')) {
            $errors += "$($target.Name): effective rule is limited by interface"
        }
    } catch { $errors += "$($target.Name): effective firewall policy could not be verified ($($_.Exception.GetType().Name))" }
    return $errors
}

$targets = @(Get-ExpectedTargets)
if ($targets.Count -eq 0 -and -not $Remove) {
    Write-Host 'No Python Software Foundation-signed python.exe or py.exe was found on this PATH. No firewall rule was changed.' -ForegroundColor Yellow
    Finish 3
}

$policy = New-Object -ComObject HNetCfg.FwPolicy2
$rules = $policy.Rules
try {
    if (-not $Remove) {
        # NET_FW_MODIFY_STATE_OK (0) means local rule changes can take effect.
        $modifyState = [int]$policy.LocalPolicyModifyState
        if ($modifyState -ne 0) {
            Write-Host "Cannot verify effective local rules: Windows policy modify state is $modifyState (0 means local rules are effective)." -ForegroundColor Red
            Finish 4
        }
        $disabledProfiles = @()
        foreach ($profile in @(
            [pscustomobject]@{ Name = 'Domain'; Bit = 1 },
            [pscustomobject]@{ Name = 'Private'; Bit = 2 },
            [pscustomobject]@{ Name = 'Public'; Bit = 4 }
        )) {
            if (-not [bool]$policy.FirewallEnabled([int]$profile.Bit)) { $disabledProfiles += [string]$profile.Name }
        }
        if ($disabledProfiles.Count) {
            Write-Host ("Cannot verify an effective block: Windows Firewall is off for " + ($disabledProfiles -join ', ') + ' profile(s).') -ForegroundColor Red
            Finish 4
        }
    }
    if ($Remove) {
        $answer = Read-Host "Remove only this tool's named Python firewall rules? [Y/N]"
        if ($answer -notmatch '^(?i:y|yes)$') { Write-Host 'No firewall rules were changed.'; Finish 0 }
        foreach ($name in @("$group - python.exe outbound", "$group - py.exe outbound")) {
            try { $rules.Remove($name) } catch { }
        }
        $remaining = @()
        foreach ($rule in $rules) {
            try {
                if ($rule.Grouping -eq $group -and $rule.Name -in @("$group - python.exe outbound", "$group - py.exe outbound")) { $remaining += $rule.Name }
            } finally {
                if ([Runtime.InteropServices.Marshal]::IsComObject($rule)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($rule) }
            }
        }
        if ($remaining.Count) {
            Write-Host ("Could not remove: " + ($remaining -join ', ')) -ForegroundColor Red
            Finish 1
        }
        Write-Host "Removed this tool's Python firewall rules." -ForegroundColor Green
        Finish 0
    }
    if ($Check) {
        $errors = @()
        foreach ($target in $targets) {
            $errors += Get-RuleErrors $rules $target
            $errors += Get-ActiveRuleErrors $target
        }
        if ($errors.Count) {
            $errors | ForEach-Object { Write-Host "FAIL: $_" -ForegroundColor Red }
            Finish 1
        }
        foreach ($target in $targets) { Write-Host "Verified outbound block: $($target.Path)" -ForegroundColor Green }
        Write-Host 'Verified in local rules and ActiveStore: enabled block rules cover Domain, Private and Public profiles.'
        Write-Host 'Scope limitation: these rules match only the listed executable paths. If Python starts another program, that program is not blocked by these rules.' -ForegroundColor Yellow
        Finish 0
    }

    Write-Host 'This changes Windows Firewall for these executables system-wide:' -ForegroundColor Yellow
    foreach ($target in $targets) { Write-Host "  $($target.Path)" }
    Write-Host 'Any application using these exact executable paths will lose outbound network access.' -ForegroundColor Yellow
    Write-Host 'The rules cover Domain, Private and Public profiles. Metered connections use their assigned profile.'
    Write-Host 'Scope limitation: Python code can start another program, whose network access is not controlled by these Python executable rules.' -ForegroundColor Yellow
    $answer = Read-Host 'Create or replace these Python outbound block rules? [Y/N]'
    if ($answer -notmatch '^(?i:y|yes)$') { Write-Host 'No firewall rules were changed.'; Finish 0 }

    foreach ($target in $targets) {
        try { $rules.Remove($target.Rule) } catch { }
        $rule = New-Object -ComObject HNetCfg.FWRule
        $rule.Name = $target.Rule
        $rule.Description = 'Created manually by Markdown Viewer Python-Firewall.cmd; blocks outbound traffic for this exact executable path.'
        $rule.ApplicationName = $target.Path
        $rule.Direction = 2
        $rule.Action = 0
        $rule.Grouping = $group
        $rule.Profiles = $allProfiles
        $rule.Protocol = 256
        $rule.LocalAddresses = '*'
        $rule.RemoteAddresses = '*'
        $rule.InterfaceTypes = 'All'
        $rule.Enabled = $true
        $rules.Add($rule)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($rule)
    }

    $errors = @()
    foreach ($target in $targets) {
        $errors += Get-RuleErrors $rules $target
        $errors += Get-ActiveRuleErrors $target
    }
    if ($errors.Count) {
        $errors | ForEach-Object { Write-Host "FAIL: $_" -ForegroundColor Red }
        Finish 1
    }
    foreach ($target in $targets) { Write-Host "Verified outbound block: $($target.Path)" -ForegroundColor Green }
    Write-Host 'Created and verified enabled block rules for all Windows firewall profiles.'
} finally {
    if ($rules -and [Runtime.InteropServices.Marshal]::IsComObject($rules)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($rules) }
    if ($policy -and [Runtime.InteropServices.Marshal]::IsComObject($policy)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($policy) }
}
