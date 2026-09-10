#requires -version 5
# Keeps the two halves of the widget alive between reboots.
#
# The Startup shortcut only fires once at logon. Anything that kills the strip
# afterwards — a crash, an explorer restart — used to leave it dead until the
# next reboot. This runs every couple of minutes and puts back whatever is
# missing. It is deliberately dumb and idempotent: the strip itself holds a
# global mutex, so a redundant launch exits on its own.
#
# Four things it must never do, all learned the hard way: report success it did
# not verify, kill the copy that actually owns the mutex, kill anything on the
# evidence of a clock that stood still while the machine slept, and keep killing
# and reviving forever without ever saying that it is not working.
$ErrorActionPreference = 'Continue'
$Root = 'C:\Tools\cc-widget'
try { . (Join-Path $Root 'common.ps1') }
catch {
    try {
        $fb = Join-Path $env:LOCALAPPDATA 'cc-widget'
        if (-not (Test-Path $fb)) { New-Item -ItemType Directory -Path $fb -Force | Out-Null }
        "$(Get-Date -Format 's')  сторож не загрузил common.ps1: $($_.Exception.Message)" |
            Add-Content -Path (Join-Path $fb 'watchdog.log') -Encoding UTF8
    } catch { }
    exit 4
}

# Code and collector output live in $Root, which the user cannot write to any
# more; everything this script writes lives in the per-user state directory,
# except manual_poll.json, which the SYSTEM collector must be able to trust.
$State     = Get-StateDir
$Log       = Join-Path $State 'watchdog.log'
$OffFlag   = Join-Path $State 'widget_off.flag'
$Beat      = Join-Path $State 'watchdog_beat.txt'
$UiBeat    = Join-Path $State 'widget_beat.txt'
$UiDiag    = Join-Path $State 'widget_diag.log'
$StateFile = Join-Path $State 'watchdog_state.json'
$Alarm     = Join-Path ([Environment]::GetFolderPath('Desktop')) 'ПОЛОСКА-РАСХОДА-НЕ-РАБОТАЕТ.txt'

# The strip draws every 5 s. A missing beat is suspicious at 60 s, but killing on
# that alone shot a healthy strip after every short standby: the "just woke up"
# threshold was 600 s and everything between 40 and 600 s fell into the hole. Now
# a kill needs the beat to have been stale for three minutes across two passes,
# and any pass that follows a gap in the watchdog's own beat only observes.
$UiDeadSec      = 60
$UiKillSec      = 180
$GapSuppressSec = 200    # normal spacing is 120 s; a longer gap means we were not running
$WakeSec        = 600    # unchanged: do not judge the collector right after a long sleep
$MaxFails       = 5      # consecutive revive passes before the visible alarm

function Write-Log($msg) {
    try {
        "$(Get-Date -Format 's')  $msg" | Add-Content -Path $Log -Encoding UTF8
        # never let the log grow without bound
        $f = Get-Item $Log
        if ($f.Length -gt 200KB) {
            (Get-Content $Log -Tail 400) | Set-Content $Log -Encoding UTF8
        }
    } catch { }
}

function Read-State {
    $s = [pscustomobject]@{ fails = 0; nextTry = [datetime]::MinValue; staleSince = [datetime]::MinValue; alarm = $false; manualAt = [datetime]::MinValue }
    try {
        if (Test-Path $StateFile) {
            $j = (Get-Content $StateFile -Raw) | ConvertFrom-Json
            if ($null -ne $j.fails) { $s.fails = [int]$j.fails }
            if ($j.nextTry)    { $s.nextTry    = [datetime]::Parse($j.nextTry) }
            if ($j.staleSince) { $s.staleSince = [datetime]::Parse($j.staleSince) }
            if ($j.manualAt)   { $s.manualAt   = [datetime]::Parse($j.manualAt) }
            if ($null -ne $j.alarm) { $s.alarm = [bool]$j.alarm }
        }
    } catch { }
    return $s
}

function Write-State($s) {
    try {
        @{ fails = $s.fails
           nextTry = $s.nextTry.ToString('o')
           staleSince = $s.staleSince.ToString('o')
           alarm = $s.alarm
           manualAt = $s.manualAt.ToString('o') } | ConvertTo-Json -Compress | Set-Content $StateFile -Encoding UTF8
    } catch { }
}

# The heartbeat now carries who wrote it, so the duplicate cleanup can spare the
# copy that is actually drawing instead of guessing by age and shooting the owner.
function Read-Beat {
    $b = [pscustomobject]@{ age = 99999; owner = 0; covered = $false }
    try {
        if (Test-Path $UiBeat) {
            $b.age = [int]((Get-Date) - (Get-Item $UiBeat).LastWriteTime).TotalSeconds
            $raw = (Get-Content $UiBeat -Raw)
            if ($raw) { $raw = $raw.Trim() }
            if ($raw -and $raw.StartsWith('{')) {
                $j = $raw | ConvertFrom-Json
                if ($j.pid) { $b.owner = [int]$j.pid }
                if ($null -ne $j.covered) { $b.covered = [bool]$j.covered }
            }
        }
    } catch { }
    return $b
}

function Get-WidgetPids {
    $pat = '*' + '-Fi' + 'le *cc-wid' + 'get*widget.ps' + '1*'
    return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -like $pat -and $_.ProcessId -ne $PID } |
             ForEach-Object { [int]$_.ProcessId })
}

# The beat names a PID, but the beat file lives in %LOCALAPPDATA%, which any
# process of this user can write, and Windows reuses PIDs freely. An elevated
# watchdog must never take that number on faith: confirm it against the
# command-line scan, and — when that scan is blind, as it is for an elevated
# strip seen from a non-elevated pass — against the window title.
function Test-WidgetPid([int]$id, [int[]]$known) {
    if ($id -le 0) { return $false }
    if ($known -contains $id) { return $true }
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if (-not $p -or $p.ProcessName -ne 'powershell') { return $false }
    return ($p.MainWindowTitle -eq 'CC Usage')
}

# Kill and then PROVE it. The old code passed -EA SilentlyContinue and logged how
# many processes it had FOUND, so an access-denied kill (watchdog unelevated, strip
# elevated) read in the log exactly like a successful one.
function Stop-Widget([int[]]$targets, [string]$why) {
    if (-not $targets -or $targets.Count -eq 0) {
        Write-Log "${why}: процесс полоски не виден — мьютекс держит кто-то, кого я не вижу (не хватает прав?). Не убиваю, не подменяю."
        return $false
    }
    $killed = 0
    foreach ($p in $targets) {
        try { Stop-Process -Id $p -Force -ErrorAction Stop }
        catch { Write-Log "${why}: PID $p убить НЕ УДАЛОСЬ: $($_.Exception.Message)"; continue }
        $gone = $false
        for ($i = 0; $i -lt 25; $i++) {
            if (-not (Get-Process -Id $p -ErrorAction SilentlyContinue)) { $gone = $true; break }
            Start-Sleep -Milliseconds 200
        }
        if ($gone) { $killed++ } else { Write-Log "${why}: PID $p не умер за 5 с" }
    }
    Write-Log "$why -> убито подтверждённо $killed из $($targets.Count)"
    return ($killed -eq $targets.Count)
}

# Success is a fresh heartbeat, not a taken mutex: the mutex proves a process,
# the beat proves a window that drew.
function Start-Widget {
    $before = if (Test-Path $UiBeat) { (Get-Item $UiBeat).LastWriteTime } else { [datetime]::MinValue }
    try {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') `
                      -ArgumentList ('"' + (Join-Path $Root 'widget.vbs') + '"') -ErrorAction Stop
    } catch { Write-Log "запустить полоску НЕ УДАЛОСЬ: $($_.Exception.Message)"; return $false }
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if ((Test-Path $UiBeat) -and (Get-Item $UiBeat).LastWriteTime -gt $before) {
            Write-Log 'полоска поднята и рисует (свежий пульс)'
            return $true
        }
    }
    $hint = ''
    try { if (Test-Path $UiDiag) { $hint = ' | последняя строка диагностики: ' + ((Get-Content $UiDiag -Tail 1) -join '') } } catch { }
    Write-Log "полоска запущена, но за 15 с не нарисовала ни кадра$hint"
    return $false
}

function Set-Alarm($s, $text) {
    if ($s.alarm) { return }
    $s.alarm = $true
    Write-Log "ЭСКАЛАЦИЯ: $text"
    try {
        $body = @("Полоска расхода Claude Code не поднимается.", "", $text, "",
                  "Сторож перестал дёргать её каждые 2 минуты и ждёт по нарастающей паузе.", "",
                  "--- последние строки $Log ---") +
                @(Get-Content $Log -Tail 12 -ErrorAction SilentlyContinue) +
                @("", "--- последние строки $UiDiag ---") +
                @(Get-Content $UiDiag -Tail 12 -ErrorAction SilentlyContinue)
        $body | Set-Content $Alarm -Encoding UTF8
    } catch { }
}

function Clear-Alarm($s) {
    if (-not $s.alarm) { return }
    $s.alarm = $false
    try { if (Test-Path $Alarm) { Remove-Item $Alarm -Force -ErrorAction SilentlyContinue } } catch { }
    Write-Log 'полоска снова жива — эскалация снята'
}

$st = Read-State

# --- 0. was there a gap? ----------------------------------------------------
# After sleep every timestamp is stale at once: data.json looks hours old even
# though the collector is perfectly healthy and about to write again. Restarting
# the service on that evidence is a false positive, so the first pass after a
# long gap only observes. The same gap, at a much lower threshold, also forbids
# killing the strip: two missed passes are enough to make a live beat look dead.
$gapSec = 0
try {
    $prev = if (Test-Path $Beat) { [datetime]::Parse((Get-Content $Beat -Raw).Trim()) } else { $null }
    if ($prev) { $gapSec = [int]((Get-Date) - $prev).TotalSeconds }
} catch { }
$justWoke = ($gapSec -gt $WakeSec)
$gapped   = ($gapSec -gt $GapSuppressSec)
try { (Get-Date -Format 'o') | Set-Content $Beat -Encoding UTF8 } catch { }

# --- 0.5 manual restart ------------------------------------------------------
# «Перезапустить» (strip menu, Ctrl+Alt+W) only drops this flag and starts this
# task: the collector is a LocalSystem service and the strip may be an elevated
# process, neither of which the unelevated button may touch. The flag's content
# is never read - it sits in a directory any process of this user can write and
# this script runs elevated, so its existence is the whole request, and the
# action it triggers is fixed. A person asked, so this outranks the gap rule,
# the crash-loop pause and a «Выход» of this session - but only once a minute,
# only for a fresh press, and never for a flag that cannot be taken away, or a
# stuck flag would restart everything on every pass.
$RestartFlag = Join-Path $State 'restart.flag'

# [IO.File]::Delete removes a link instead of following it and refuses a
# directory; this runs elevated against a directory any process of this user
# can write, so Remove-Item's helpfulness is the wrong default here.
function Remove-UserFile([string]$p) {
    try { [IO.File]::Delete($p) } catch { return $false }
    return -not (Test-Path -LiteralPath $p)
}

# The throttle reads a clock this user cannot edit: watchdog_state.json sits in
# the per-user directory, and a limit kept only there could be zeroed by any
# process of this user, turning the button into an elevated restart-at-will of
# a LocalSystem service. The collector's own process start is kept by the OS.
function Get-CollectorAgeSec {
    try {
        $sp = (Get-CimInstance Win32_Service -Filter "Name='CCWidgetCollector'" -ErrorAction Stop).ProcessId
        if ($sp -gt 0) {
            $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$sp" -ErrorAction Stop).CreationDate
            if ($c) { return [int]((Get-Date) - $c).TotalSeconds }
        }
    } catch { }
    return 99999
}

function Invoke-ManualRestart {
    if (-not (Test-Path -LiteralPath $RestartFlag)) { return $false }
    $flagAge = 99999
    try { $flagAge = [int]((Get-Date) - (Get-Item -LiteralPath $RestartFlag -Force).LastWriteTime).TotalSeconds } catch { }
    if (-not (Remove-UserFile $RestartFlag)) {
        Write-Log 'restart.flag не снимается — перезапуск не делаю, иначе он шёл бы каждый проход'
        return $false
    }
    # a press from before a sleep, or one whose button already gave up and said so
    if ($flagAge -gt 180) {
        Write-Log "restart.flag пролежал $flagAge с — нажатие устарело, пропущен"
        return $false
    }
    # doubles: manualAt starts at MinValue, and its age does not fit an [int]
    $since = [math]::Min(((Get-Date) - $st.manualAt).TotalSeconds, [double](Get-CollectorAgeSec))
    if ($since -lt 60) {
        Write-Log "ручной перезапуск: прошлый был $([int]$since) с назад, чаще раза в минуту не делаю"
        return $false
    }
    $st.manualAt = Get-Date
    Write-Log 'РУЧНОЙ ПЕРЕЗАПУСК'
    # The strip first: the press dimmed it, and a strip still drawing ten seconds
    # later reads as a press that did nothing. Every copy the scan confirms.
    $pids = Get-WidgetPids
    $okKill = $true
    if ($pids.Count -gt 0) { $okKill = Stop-Widget $pids 'ручной перезапуск' }
    # The poll marker goes in while the collector is down. Written before a
    # restart, a tick of the old process could take it and die mid-request, and
    # the press was lost with it. The probe honours the marker only over a
    # network failure or the normal rhythm, never over a server's penalty.
    try { Stop-Service -Name CCWidgetCollector -Force -ErrorAction Stop }
    catch { Write-Log "сервис НЕ остановлен: $($_.Exception.Message)" }
    $marker = Join-Path $Root 'manual_poll.json'
    try {
        [IO.File]::Delete($marker)
        [IO.File]::WriteAllText($marker, '{"at":' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '}')
    } catch { Write-Log "manual_poll.json не записан: $($_.Exception.Message)" }
    try {
        Start-Service -Name CCWidgetCollector -ErrorAction Stop
        Write-Log 'сервис перезапущен'
    } catch { Write-Log "сервис НЕ запущен: $($_.Exception.Message)" }
    [void](Remove-UserFile $UiBeat)
    [void](Remove-UserFile $OffFlag)
    $st.staleSince = [datetime]::MinValue
    if (-not $okKill) {
        # same rule as an ordinary revive: the mutex may still be held by the copy
        # that would not die, and a beat it writes would pass for the new one
        Write-Log 'старая копия полоски не убита — новую не поднимаю'
        $st.fails = [math]::Max(1, $st.fails)
        $st.nextTry = (Get-Date).AddMinutes(2)
    } elseif (Start-Widget) {
        $st.fails = 0
        $st.nextTry = [datetime]::MinValue
        Clear-Alarm $st
    } else {
        # the next pass must not shoot a copy that is still coming up
        $st.fails = [math]::Max(1, $st.fails)
        $st.nextTry = (Get-Date).AddMinutes(2)
    }
    Write-State $st
    return $true
}

if (Invoke-ManualRestart) { exit 0 }

# --- 1. the collector service ---------------------------------------------
$svc = Get-Service -Name CCWidgetCollector -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.StartType -ne 'Automatic') {
        # This one needs SERVICE_CHANGE_CONFIG, which the watchdog deliberately
        # does NOT have any more: the right to repoint a LocalSystem service is
        # the whole EoP we are closing. Log it and let a human fix it elevated.
        try {
            Set-Service -Name CCWidgetCollector -StartupType Automatic -ErrorAction Stop
            Write-Log 'сервис переведён в Automatic'
        } catch { Write-Log "сервис не в Automatic и переключить нечем (нужны права админа): $($_.Exception.Message)" }
    }
    if ($svc.Status -ne 'Running') {
        # the old version logged "-> запущен" before checking, so a service that
        # failed to start left a log full of successes
        try {
            Start-Service -Name CCWidgetCollector -ErrorAction Stop
            $svc.Refresh()
            if ($svc.Status -eq 'Running') { Write-Log "сервис был $($svc.Status) -> запущен" }
            else { Write-Log "сервис НЕ поднялся, статус $($svc.Status)" }
        } catch { Write-Log "сервис НЕ запустился: $($_.Exception.Message)" }
    }
} else {
    Write-Log 'сервис CCWidgetCollector не зарегистрирован'
}

# --- 2. data must actually be moving --------------------------------------
# A running service that stopped writing is worse than a stopped one, because
# the strip keeps showing a number that is quietly hours old.
$dataFile = Join-Path $Root 'data.json'
if ((Test-Path $dataFile) -and -not $justWoke) {
    $age = ((Get-Date) - (Get-Item $dataFile).LastWriteTime).TotalSeconds
    if ($age -gt 300) {
        try {
            Restart-Service -Name CCWidgetCollector -Force -ErrorAction Stop
            Write-Log "data.json не обновлялся $([int]$age) с -> сервис перезапущен"
        } catch { Write-Log "data.json не обновлялся $([int]$age) с, перезапуск НЕ УДАЛСЯ: $($_.Exception.Message)" }
    }
} elseif ($justWoke) {
    Write-Log "пробуждение из сна (пауза $gapSec с) — проверка возраста data.json пропущена"
}

# --- 3. «Выход» is per logon session, not per boot -------------------------
# The flag used to be compared with LastBootUpTime. Fast Startup (HiberbootEnabled=1)
# does not move that clock on a normal shutdown, so «до перезагрузки» silently
# became «навсегда». The flag now carries the session it was written in.
if (Test-Path $OffFlag) {
    $key = Get-SessionKey
    $inFlag = ''
    try { $inFlag = ((Get-Content $OffFlag -Raw -ErrorAction SilentlyContinue)) ; if ($inFlag) { $inFlag = $inFlag.Trim() } } catch { }
    $stale = $false
    if ($key) {
        $stale = ($inFlag -ne $key)
    } else {
        # session identity unavailable: fall back to the old, weaker rule
        try { $stale = ((Get-Item $OffFlag).LastWriteTime -lt (Get-CimInstance Win32_OperatingSystem).LastBootUpTime) } catch { }
    }
    if ($stale) {
        try { Remove-Item $OffFlag -Force -ErrorAction SilentlyContinue } catch { }
        Write-Log 'widget_off.flag остался от прошлого сеанса -> снят'
    }
}

# --- 4. the strip itself ---------------------------------------------------
# Liveness comes from the mutex, not from the command line: a non-elevated query
# reads CommandLine as $null for an elevated process, so the strip was reported
# dead while it was running and a second copy got launched every two minutes.
$alive = $false
$mtx = $null
try {
    $mtx = New-Object System.Threading.Mutex($false, 'Global\CCUsageWidget')
    $free = $false
    try { $free = $mtx.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $free = $true }
    $alive = -not $free
    # release immediately; disposing while holding it would abandon it and make
    # the next probe believe the strip had crashed
    if ($free) { try { $mtx.ReleaseMutex() } catch { } }
} catch { $alive = $false }
finally { if ($mtx) { try { $mtx.Dispose() } catch { } } }

$beat = Read-Beat
$pids = Get-WidgetPids
$acted = $false

# The mutex probe can fail for reasons that say nothing about the strip: opening
# a Global\ handle created at a higher integrity level throws UnauthorizedAccess,
# so a non-elevated pass would read a perfectly healthy strip as gone, launch a
# copy that exits on the mutex at once, and count that as an intervention until
# the crash-loop limiter put an alarm on the desktop. A fresh beat whose owner is
# still alive is direct evidence of a strip that drew, and it outranks a probe
# that only failed to look.
if (-not $alive -and $beat.age -le $UiDeadSec -and (Test-WidgetPid $beat.owner $pids)) {
    $alive = $true
    Write-Log "проба мьютекса не удалась, но пульс свежий ($($beat.age) с) и владелец PID $($beat.owner) жив — считаю полоску живой"
}

# A held mutex proves a process exists, not that anything is on screen. The strip
# was once found alive, holding the mutex, drawing nothing — and this watchdog
# reported it healthy for as long as it kept breathing.
if ($alive -and $beat.age -le $UiDeadSec) {
    $st.staleSince = [datetime]::MinValue
    if ($beat.covered) { Write-Log 'полоска рисует, но её перекрывает чужое окно (сама возвращает z-order) — не трогаю' }
} elseif ($alive -and $gapped) {
    Write-Log "пульса нет ($($beat.age) с), но между проходами была пауза $gapSec с — в этот проход только смотрю"
} elseif ($alive) {
    if ($st.staleSince -eq [datetime]::MinValue) {
        $st.staleSince = (Get-Date).AddSeconds(-$beat.age)
    }
    $staleFor = [int]((Get-Date) - $st.staleSince).TotalSeconds
    if ($staleFor -lt $UiKillSec) {
        Write-Log "полоска жива, но пульса нет $($beat.age) с (подряд $staleFor с из $UiKillSec) — жду ещё проход"
    } elseif ((Get-Date) -lt $st.nextTry) {
        Write-Log "полоска не рисует, но пауза после сбоев до $($st.nextTry.ToString('HH:mm')) — не трогаю"
    } else {
        # kill the copy that the beat named, if we know it and it is still a
        # powershell process; otherwise fall back to the command-line scan
        $targets = if (Test-WidgetPid $beat.owner $pids) { @($beat.owner) } else { $pids }
        $okKill = Stop-Widget $targets "полоска жива, но не рисует ($($beat.age) с без пульса)"
        try { Remove-Item $UiBeat -Force -ErrorAction SilentlyContinue } catch { }
        $st.staleSince = [datetime]::MinValue
        $acted = $true
        if ($okKill) { $alive = $false }
        else { Write-Log 'мьютекс мог остаться за неубитым процессом — подъём в этот проход не делаю' }
    }
}

if (-not $alive -and -not (Test-Path $OffFlag)) {
    if ((Get-Date) -lt $st.nextTry) {
        Write-Log "полоски нет, но пауза после сбоев до $($st.nextTry.ToString('HH:mm')) — не поднимаю"
    } else {
        $acted = $true
        [void](Start-Widget)
    }
} elseif (-not $alive) {
    # a strip the user switched off is not a failure: drop the escalation, or the
    # file on the desktop would sit there accusing a healthy machine
    Write-Log 'полоска выключена пользователем (widget_off.flag)'
    $st.fails = 0
    $st.nextTry = [datetime]::MinValue
    Clear-Alarm $st
}

# --- 5. crash-loop limiter -------------------------------------------------
# A run of "убил -> поднял" cycles ($MaxFails of them) is not maintenance, it is a loop, and
# the old watchdog would have run it until the machine was switched off. A pass
# where nothing had to be done is the only thing that counts as success.
if ($acted) {
    $st.fails++
    $delayMin = [math]::Min(60, [math]::Pow(2, [math]::Min($st.fails, 6)))
    $st.nextTry = (Get-Date).AddMinutes($delayMin)
    Write-Log "вмешательств подряд: $($st.fails); следующая попытка не раньше $($st.nextTry.ToString('HH:mm'))"
    if ($st.fails -ge $MaxFails) {
        Set-Alarm $st "полоска не держится: $($st.fails) циклов «убил -> поднял» подряд"
    }
} elseif ($alive -and $beat.age -le $UiDeadSec) {
    if ($st.fails -gt 0) { Write-Log 'полоска стабильна — счётчик сбоев сброшен' }
    $st.fails = 0
    $st.nextTry = [datetime]::MinValue
    Clear-Alarm $st
}

# --- 6. duplicates ---------------------------------------------------------
# The mutex makes this all but impossible. Both previous versions made it worse:
# one killed everything except the newest (i.e. the mutex owner), the other kept
# the OLDEST, which is the corpse a failed kill left behind. Now nothing is shot
# unless the heartbeat says who the owner is.
if ($pids.Count -gt 1) {
    if ($beat.owner -gt 0 -and $beat.age -le $UiDeadSec -and ($pids -contains $beat.owner)) {
        $extra = @($pids | Where-Object { $_ -ne $beat.owner })
        [void](Stop-Widget $extra "найдено $($pids.Count) копий, рисует PID $($beat.owner)")
    } else {
        Write-Log "найдено $($pids.Count) копий, но владелец не подтверждён пульсом — не трогаю ни одну"
    }
}

# A press that landed while this pass was running was dropped by the scheduler
# (IgnoreNew), and the button's retries can all fall inside one long pass. The
# flag is still there: serve it now, not two minutes from now.
if (Invoke-ManualRestart) { exit 0 }

Write-State $st
