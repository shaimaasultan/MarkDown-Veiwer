# Sample script - shown, never run.
param([string]$Path = '.')
# The next comment hides a text-direction control: ‮}gnihton od #
Get-ChildItem -LiteralPath $Path | Where-Object Length -gt 1MB
Remove-Item -LiteralPath (Join-Path $Path 'old.tmp') -WhatIf
