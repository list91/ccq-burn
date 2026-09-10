#requires -version 5
# Removes everything install.ps1 created:
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
param([switch]$Elevated)
$ErrorActionPreference = 'Continue'
$Root = 'C:\Tools\cc-widget'

if (-not $Elevated) {
    try {
        $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
    } catch { Write-Host 'Admin rights were not granted - nothing was removed.' -ForegroundColor Red; exit 1 }
    # per-user bits after everything is stopped, so nothing recreates them
    Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup'))  'CC Usage Widget.lnk') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path ([Environment]::GetFolderPath('Programs')) 'CC Usage - restart strip.lnk') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'ПОЛОСКА-РАСХОДА-НЕ-РАБОТАЕТ.txt') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:LOCALAPPDATA 'cc-widget') -Recurse -Force -ErrorAction SilentlyContinue
    if ($p.ExitCode -eq 0) { Write-Host 'ccq-burn removed.' -ForegroundColor Green }
    exit $p.ExitCode
}

Stop-ScheduledTask -TaskName CCWidgetWatchdog -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName CCWidgetWatchdog -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*cc-widget\watchdog.ps1*' -or $_.CommandLine -like '*cc-widget\widget.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (Get-Service CCWidgetCollector -ErrorAction SilentlyContinue) {
    Stop-Service CCWidgetCollector -Force -ErrorAction SilentlyContinue
    & sc.exe delete CCWidgetCollector | Out-Null
}
Start-Sleep -Seconds 2
Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path $Root) { Write-Host "Could not delete $Root completely - remove it by hand."; Read-Host 'Enter to close'; exit 1 }
exit 0
