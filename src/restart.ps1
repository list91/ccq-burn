#requires -version 5
# «Перезапустить полоску» - the strip's menu item and the Ctrl+Alt+W shortcut
# both land here. Nothing is restarted from this script: the collector is a
# LocalSystem service and the strip may be an elevated process, and this runs
# as the plain user. It drops a flag and starts the watchdog task, which runs
# elevated and does the restart (watchdog.ps1, step 0.5).
$ErrorActionPreference = 'Continue'
$Root = 'C:\Tools\cc-widget'
try { . (Join-Path $Root 'common.ps1') } catch { exit 4 }
$State = Get-StateDir
$Flag  = Join-Path $State 'restart.flag'
$Log   = Join-Path $State 'watchdog.log'
function Write-Log($msg) {
    try { "$(Get-Date -Format 's')  [кнопка] $msg" | Add-Content -Path $Log -Encoding UTF8 } catch { }
}

try { (Get-Date -Format 'o') | Set-Content $Flag -Encoding UTF8 -ErrorAction Stop }
catch { Write-Log "restart.flag не записан: $($_.Exception.Message)"; exit 2 }

# The task is IgnoreNew: a press that lands while a scheduled pass is running is
# silently dropped by the scheduler. That pass takes the flag at its end, and
# these retries cover the rest.
$err = $null
for ($try = 0; $try -lt 3; $try++) {
    try { Start-ScheduledTask -TaskName CCWidgetWatchdog -ErrorAction Stop; $err = $null }
    catch {
        $err = $_.Exception.Message
        # a pass already running serves the flag at its end; a missing or
        # disabled task never will, and 45 s of waiting helps no one
        $ts = $null
        try { $ts = (Get-ScheduledTask -TaskName CCWidgetWatchdog -ErrorAction Stop).State } catch { }
        if ("$ts" -ne 'Running') { break }
    }
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Test-Path $Flag)) { exit 0 }
    }
}
# Take the flag back: left behind, it would restart everything at some later
# pass, long after this press was reported as failed.
$taken = $false
try { Remove-Item $Flag -Force -ErrorAction Stop } catch { $taken = -not (Test-Path $Flag) }
if ($taken) { exit 0 }   # the watchdog got to it in the last instant
Write-Log "сторож не забрал restart.flag за 45 с$(if ($err) { ': ' + $err })"
try {
    Add-Type -AssemblyName PresentationFramework
    [void][Windows.MessageBox]::Show(
        "Полоска не перезапустилась: задача CCWidgetWatchdog не отвечает.`n$err`n`nЛог: $Log",
        'CC Usage')
} catch { }
exit 1
