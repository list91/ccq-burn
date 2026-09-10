#requires -version 5
# Registers the watchdog as a scheduled task. Must run elevated: the watchdog
# starts and restarts a service, and the task is created with the highest
# privileges so it can do that without a prompt every two minutes.
#
# Run: right-click -> Run as administrator, or via install_autostart.bat
param([string]$User = "$env:USERDOMAIN\$env:USERNAME")
$ErrorActionPreference = 'Stop'
$Name = 'CCWidgetWatchdog'
$Root = 'C:\Tools\cc-widget'

$action = New-ScheduledTaskAction -Execute 'wscript.exe' `
    -Argument ('"' + (Join-Path $Root 'watchdog.vbs') + '"') -WorkingDirectory $Root

# At logon, then every two minutes forever. The logon trigger alone would only
# cover reboots; the repetition is what survives a mid-session crash.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$trigger.Delay = 'PT20S'
$rep = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes 2)

$principal = New-ScheduledTaskPrincipal -UserId $User `
    -LogonType Interactive -RunLevel Highest

# The strip is a GUI process: it has to live in the interactive session, so the
# task deliberately does NOT run when nobody is logged on.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $Name -Action $action `
    -Trigger @($trigger, $rep) -Principal $principal -Settings $settings `
    -Description 'Keeps the Claude Code usage collector and strip alive (ccq-burn)' | Out-Null

Get-ScheduledTask -TaskName $Name | Select-Object TaskName, State | Format-List
Start-ScheduledTask -TaskName $Name
'registered and started'
