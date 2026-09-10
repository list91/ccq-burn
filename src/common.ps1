#requires -version 5
# Shared by widget.ps1 and watchdog.ps1. Two things both halves must agree on:
# where mutable state lives, and what "this logon session" means.

# C:\Tools\cc-widget holds code and the file the SYSTEM collector writes; it is
# read-only for the user (that is what stops an unelevated overwrite of collect.mjs
# from becoming SYSTEM). Everything the strip and the watchdog write themselves
# lives here instead, and an elevated and a non-elevated copy of the same user
# resolve this to the same path.
# The callers run under $ErrorActionPreference='Stop' and call this before any
# diagnostics file exists, so an empty LOCALAPPDATA (a stripped service profile,
# a shell started with a scrubbed environment) would throw out of Join-Path and
# kill the strip with no console, no log and no clue. Fall back instead.
function Get-StateDir {
    $d = $null
    foreach ($base in @($env:LOCALAPPDATA, $env:TEMP, "$env:USERPROFILE\AppData\Local")) {
        if ([string]::IsNullOrWhiteSpace($base)) { continue }
        try { $d = Join-Path $base 'cc-widget' } catch { continue }
        if (Test-Path $d) { return $d }
        try { New-Item -ItemType Directory -Path $d -Force | Out-Null; return $d } catch { $d = $null }
    }
    # last resort: the code directory. Read-only for the user once the ACL is
    # tightened, so this is a degraded mode, not a silent one — the caller will
    # log the write failures it then gets.
    return 'C:\Tools\cc-widget'
}

# «Выход (до перезагрузки)» used to compare the flag with LastBootUpTime. With
# Fast Startup (HiberbootEnabled=1) that clock does not move on a normal shutdown,
# so "until the next reboot" quietly became "forever". A logon session is the unit
# the user actually means: session id plus the start of that session's winlogon,
# which no user action can restart.
function Get-SessionKey {
    try {
        $sid = (Get-Process -Id $PID).SessionId
        $wl = @(Get-CimInstance Win32_Process -Filter "Name='winlogon.exe'" -ErrorAction Stop |
                Where-Object { $_.SessionId -eq $sid } | Sort-Object CreationDate | Select-Object -First 1)
        if ($wl.Count -eq 1 -and $wl[0].CreationDate) {
            return ('{0}|{1}' -f $sid, $wl[0].CreationDate.ToUniversalTime().ToString('o'))
        }
    } catch { }
    return $null   # caller falls back to the old boot-time rule
}
