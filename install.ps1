#requires -version 5
# ccq-burn installer. Run from the repo folder:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
# Runs as you for the checks, relaunches itself elevated once for the parts
# that need admin (files, service, scheduled task, ACL), then creates your shortcuts.
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

$Log     = Join-Path $env:TEMP 'ccq-burn-install.log'
function Say($m)  { Write-Host "  $m"; Add-Content $Log "  $m" -ErrorAction SilentlyContinue }
function Step($m) { Write-Host "`n> $m" -ForegroundColor Cyan; Add-Content $Log "> $m" -ErrorAction SilentlyContinue }
function Die($m)  { Write-Host "`nERROR: $m" -ForegroundColor Red; Add-Content $Log "ERROR: $m" -ErrorAction SilentlyContinue
                    if ($Elevated) { Read-Host 'Press Enter to close' }; exit 1 }

if (-not $Elevated) {
    Step 'Checking prerequisites'
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { Die 'Node.js not found. Install Node.js 18+ from https://nodejs.org and re-run.' }
    # the real binary, not a version-manager shim: the service runs as LocalSystem
    # with none of your environment, forever
    $nodeExe = (& $node.Source -p 'process.execPath').Trim()
    $ver = [version]((& $nodeExe -v).TrimStart('v'))
    if ($ver.Major -lt 18) { Die "Node.js $ver is too old, need 18+." }
    if ($nodeExe -match 'fnm_multishells|\\volta\\|\\Temp\\') {
        Die "Node at $nodeExe is a temporary/shim path (fnm/Volta). Install Node.js from https://nodejs.org (system-wide) and re-run."
    }
    Say "Node.js $ver  ($nodeExe)"
    $cred = Join-Path $env:USERPROFILE '.claude\.credentials.json'
    if (-not (Test-Path $cred)) { Die "No $cred. Install Claude Code and log in (run 'claude' once) with your Pro/Max account, then re-run." }
    Say 'Claude Code login found'

    Step 'Asking for admin rights (service + scheduled task) - accept the UAC prompt'
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated',
              '-TargetUser', "`"$env:USERDOMAIN\$env:USERNAME`"", '-TargetProfile', "`"$env:USERPROFILE`"", '-NodePath', "`"$nodeExe`"")
    if ($NssmPath) { $argv += @('-NssmPath', "`"$NssmPath`"") }
    try { $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $argv -Wait -PassThru }
    catch { Die 'Admin rights were not granted - nothing was installed. Re-run and accept the UAC prompt.' }
    if ($p.ExitCode -ne 0) { Die 'Elevated part failed - see the window it opened. Fix the cause and re-run install.ps1 (or run uninstall.ps1).' }

    # shortcuts only after the files exist, so a cancelled install leaves nothing behind
    Step 'Creating shortcuts'
    $sh = New-Object -ComObject WScript.Shell
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $lnk = $sh.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'CC Usage Widget.lnk'))
    $lnk.TargetPath = $wscript; $lnk.Arguments = "`"$Root\widget.vbs`""; $lnk.WorkingDirectory = $Root
    $lnk.Save()
    # the Start Menu shortcut carries the global hotkey Ctrl+Alt+W -> restart everything
    $lnk = $sh.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Programs')) 'CC Usage - restart strip.lnk'))
    $lnk.TargetPath = $wscript; $lnk.Arguments = "`"$Root\restart.vbs`""; $lnk.WorkingDirectory = $Root
    $lnk.Hotkey = 'CTRL+ALT+W'
    $lnk.Save()
    Say 'Startup + Start Menu (Ctrl+Alt+W)'

    Write-Host "`nDone. The strip appears on the taskbar, left of the tray, within a minute." -ForegroundColor Green
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
        Where-Object { $_.CommandLine -like '*cc-widget\widget.ps1*' -or $_.CommandLine -like '*cc-widget\watchdog.ps1*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    Step "Copying files to $Root"
    # C:\Tools inherits Modify from C:\ for every signed-in user, so anyone could
    # rename it away and plant their own cc-widget folder that the elevated
    # watchdog and the SYSTEM service would then run. Pin the parent: admin-owned,
    # signed-in users may still add folders to C:\Tools and keep Modify on
    # everything inside it, but lose DELETE on C:\Tools itself. (A Deny ACE would
    # be simpler but breaks node: fs.lstat on the folder fails with EPERM.)
    $Parent = Split-Path $Root
    New-Item -ItemType Directory -Path $Parent -Force | Out-Null
    & icacls $Parent /setowner '*S-1-5-32-544' /C /Q | Out-Null
    & icacls $Parent /remove:d '*S-1-5-11' /C /Q | Out-Null
    & icacls $Parent /inheritance:d /C /Q | Out-Null
    & icacls $Parent /remove:g '*S-1-5-11' /C /Q | Out-Null
    & icacls $Parent /grant '*S-1-5-11:(OI)(CI)(IO)M' '*S-1-5-11:(RX,WD,AD)' /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed on $Parent" }
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    # a re-install must be able to overwrite files whatever ACL they carry now
    & icacls $Root /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
    & icacls "$Root\*" /reset /T /C /Q | Out-Null
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
        # this binary ends up running as SYSTEM: refuse anything but the known release
        if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne '727D1E42275C605E0F04ABA98095C38A8E1E46DEF453CDFFCE42869428AA6743') {
            Remove-Item $zip -Force; throw 'nssm-2.24.zip checksum mismatch - download it yourself and pass -NssmPath'
        }
        $x = Join-Path $env:TEMP 'nssm-2.24-x'
        Expand-Archive $zip $x -Force
        Copy-Item (Join-Path $x 'nssm-2.24\win64\nssm.exe') $nssm -Force
        Remove-Item $zip, $x -Recurse -Force -ErrorAction SilentlyContinue
    }
    Say $nssm

    # The watchdog runs elevated from this folder, so users must not be able to
    # write here - otherwise any process of yours could swap a script and get admin.
    Step 'Locking the folder (admins/SYSTEM write, users read)'
    # owner first: an owner can always rewrite the ACL, and C:\Tools may have been
    # created by you earlier
    & icacls $Root /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
    # the folder gets explicit inheritable ACEs; everything inside just inherits them
    # (applying (OI)(CI) to files with /T leaves them with an empty DACL)
    & icacls $Root /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }
    & icacls "$Root\*" /reset /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'icacls reset failed' }

    Step "Installing service $Service (runs as LocalSystem)"
    # right after an uninstall the old service can still be 'marked for deletion'
    for ($i = 0; $i -lt 30 -and (Test-Path "HKLM:\SYSTEM\CurrentControlSet\Services\$Service") -and
                 -not (Get-Service $Service -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
    if (-not (Get-Service $Service -ErrorAction SilentlyContinue)) {
        & $nssm install $Service $node "`"$Root\collect.mjs`"" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "nssm install failed with exit code $LASTEXITCODE" }
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
