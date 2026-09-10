#requires -version 5
# ccq-burn installer. Run from the repo folder:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# The first half runs as you (checks, shortcuts); it then relaunches itself
# elevated once for the parts that need admin (service, scheduled task, ACL).
param(
    [switch]$Elevated,
    [string]$TargetUser,
    [string]$TargetProfile,
    [string]$NssmPath,
    [string]$NodePath
)
$ErrorActionPreference = 'Stop'
$Root    = 'C:\Tools\cc-widget'
$Src     = Join-Path $PSScriptRoot 'src'
$Service = 'CCWidgetCollector'
$Task    = 'CCWidgetWatchdog'

function Say($m)  { Write-Host "  $m" }
function Step($m) { Write-Host "`n> $m" -ForegroundColor Cyan }
function Die($m)  { Write-Host "`nERROR: $m" -ForegroundColor Red; if ($Elevated) { Read-Host 'Press Enter to close' }; exit 1 }

if (-not $Elevated) {
    Step 'Checking prerequisites'
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { Die 'Windows only.' }
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Die 'Node.js not found. Install Node.js 18+ from https://nodejs.org and re-run.' }
    $ver = [version]((& $node.Source -v).TrimStart('v'))
    if ($ver.Major -lt 18) { Die "Node.js $ver is too old, need 18+." }
    Say "Node.js $ver  ($($node.Source))"
    $cred = Join-Path $env:USERPROFILE '.claude\.credentials.json'
    if (-not (Test-Path $cred)) { Die "No $cred. Install Claude Code and log in (run 'claude' once) with your Pro/Max account, then re-run." }
    Say 'Claude Code login found'

    Step 'Creating shortcuts'
    $sh = New-Object -ComObject WScript.Shell
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $startup = [Environment]::GetFolderPath('Startup')
    $lnk = $sh.CreateShortcut((Join-Path $startup 'CC Usage Widget.lnk'))
    $lnk.TargetPath = $wscript; $lnk.Arguments = "`"$Root\widget.vbs`""; $lnk.WorkingDirectory = $Root
    $lnk.Save()
    # Start Menu shortcut carries the global hotkey Ctrl+Alt+W -> restart everything
    $progs = [Environment]::GetFolderPath('Programs')
    $lnk = $sh.CreateShortcut((Join-Path $progs 'CC Usage - restart strip.lnk'))
    $lnk.TargetPath = $wscript; $lnk.Arguments = "`"$Root\restart.vbs`""; $lnk.WorkingDirectory = $Root
    $lnk.Hotkey = 'CTRL+ALT+W'
    $lnk.Save()
    Say 'Startup + Start Menu (Ctrl+Alt+W) shortcuts'

    Step 'Asking for admin rights (service + scheduled task)'
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated',
              '-TargetUser', "`"$env:USERDOMAIN\$env:USERNAME`"", '-TargetProfile', "`"$env:USERPROFILE`"", '-NodePath', "`"$($node.Source)`"")
    if ($NssmPath) { $argv += @('-NssmPath', "`"$NssmPath`"") }
    $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $argv -Wait -PassThru
    if ($p.ExitCode -ne 0) { Die 'Elevated part failed - see the window it opened.' }
    Write-Host "`nDone. The strip appears on the taskbar within a minute." -ForegroundColor Green
    Write-Host 'Drag it anywhere; right-click for the menu; Ctrl+Alt+W restarts everything.'
    exit 0
}

# ---------------- elevated part ----------------
try {
    $node = if ($NodePath) { $NodePath } else { (Get-Command node -ErrorAction Stop).Source }

    Step 'Stopping a previous install (if any)'
    Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
    if (Get-Service $Service -ErrorAction SilentlyContinue) { Stop-Service $Service -Force -ErrorAction SilentlyContinue }
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.CommandLine -like '*cc-widget\widget.ps1*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    Step "Copying files to $Root"
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    Get-ChildItem $Src -File | Where-Object Name -ne 'config.example.json' |
        Copy-Item -Destination $Root -Force
    $cfgPath = Join-Path $Root 'config.json'
    if (Test-Path $cfgPath) { Say 'config.json kept (already exists)' }
    else {
        $cfg = Get-Content (Join-Path $Src 'config.example.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $cfg.claudeDir = Join-Path $TargetProfile '.claude\projects'
        $cfg.credPath  = Join-Path $TargetProfile '.claude\.credentials.json'
        [IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
        Say 'config.json written'
    }

    Step 'Getting NSSM (service wrapper)'
    $nssm = Join-Path $Root 'nssm.exe'
    if ($NssmPath) { Copy-Item $NssmPath $nssm -Force }
    elseif (-not (Test-Path $nssm)) {
        $zip = Join-Path $env:TEMP 'nssm-2.24.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip -UseBasicParsing
        $x = Join-Path $env:TEMP 'nssm-2.24-x'
        Expand-Archive $zip $x -Force
        Copy-Item (Join-Path $x 'nssm-2.24\win64\nssm.exe') $nssm -Force
        Remove-Item $zip, $x -Recurse -Force -ErrorAction SilentlyContinue
    }
    Say $nssm

    # The watchdog runs elevated from this folder, so users must not be able to
    # write here - otherwise any process of yours could swap a script and get admin.
    Step 'Locking the folder (admins/SYSTEM write, users read)'
    & icacls $Root /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /T /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }

    Step "Installing service $Service (runs as LocalSystem)"
    if (-not (Get-Service $Service -ErrorAction SilentlyContinue)) {
        & $nssm install $Service $node "`"$Root\collect.mjs`"" | Out-Null
    } else {
        & $nssm set $Service Application $node | Out-Null
        & $nssm set $Service AppParameters "`"$Root\collect.mjs`"" | Out-Null
    }
    & $nssm set $Service AppDirectory $Root | Out-Null
    & $nssm set $Service DisplayName 'Claude Code usage collector (ccq-burn)' | Out-Null
    & $nssm set $Service AppExit Default Restart | Out-Null
    & $nssm set $Service AppRestartDelay 5000 | Out-Null
    & $nssm set $Service AppThrottle 10000 | Out-Null
    & $nssm set $Service AppStdout "$Root\svc.log" | Out-Null
    & $nssm set $Service AppStderr "$Root\svc.log" | Out-Null
    & $nssm set $Service AppRotateFiles 1 | Out-Null
    & $nssm set $Service AppRotateBytes 1048576 | Out-Null
    & $nssm set $Service Start SERVICE_AUTO_START | Out-Null
    Start-Service $Service
    Say (Get-Service $Service).Status

    Step "Registering scheduled task $Task (keeps both halves alive)"
    & (Join-Path $Root 'install_autostart.ps1') -User $TargetUser | Out-Null
    Say 'ok'
    exit 0
} catch {
    Die $_.Exception.Message
}
