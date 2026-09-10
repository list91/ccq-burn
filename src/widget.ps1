#requires -version 5
# CC Usage widget: always-on-top overlay near the tray. Reads data.json written by collect.mjs.
#
# Two groups, each a bar with its own caption, so nothing has to be remembered:
#   [5ч  ][▓▓▓░░░] 25%~› 18%/ч›132%   4:12 │ нед [▓▓▓▓░] 80%
#   5h: fact bar + forecast ghost, fact, pace, forecast, time to reset | week.
# M is the failure channel: it reads «5ч» while everything is trustworthy and
# the failure word takes its place when not. The
# rule the whole file obeys: a number on this strip is either measured or
# marked. The server answers whole percent every 5 minutes; between answers the
# local extrapolation gets a "~", and once the answer is old the extrapolation
# is dropped entirely rather than dressed up as fact.
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Drawing

$ErrorActionPreference = 'Stop'

$Root = 'C:\Tools\cc-widget'
# A missing include used to be the quietest death of all: -WindowStyle Hidden,
# no console, no log, and a watchdog that only ever saw «мьютекс свободен».
try {
    . (Join-Path $Root 'common.ps1')
    . (Join-Path $Root 'fmt.ps1')
} catch {
    try {
        $fb = Join-Path $env:LOCALAPPDATA 'cc-widget'
        if (-not (Test-Path $fb)) { New-Item -ItemType Directory -Path $fb -Force | Out-Null }
        [IO.File]::AppendAllText((Join-Path $fb 'widget_diag.log'),
            ('{0} не загрузился модуль: {1}{2}' -f (Get-Date -Format 's'), $_.Exception.Message, [Environment]::NewLine),
            [Text.Encoding]::UTF8)
    } catch { }
    exit 4
}

$DataFile = Join-Path $Root 'data.json'
$StateDir = Get-StateDir
$PosFile  = Join-Path $StateDir 'widget_pos.json'
$OffFlag  = Join-Path $StateDir 'widget_off.flag'
$BeatFile = Join-Path $StateDir 'widget_beat.txt'
$DiagFile = Join-Path $StateDir 'widget_diag.log'
# the collector ticks every 5 s; three missed ticks is a dead collector
$DeadSec  = 90
# The weekly figure comes from the server and ages slower than the 5h one: the
# window is 10080 minutes, and the heaviest week on record moved ~0.7%/hour. Half
# a day of drift is worth up to eight points, which is more than the digits claim.
$WeekBlindMin = 720

# Diagnostics. Every catch in this file used to be empty and the dispatcher
# handler swallowed the rest, so a strip that died mid-draw left no trace at all
# and the watchdog kept reviving it blind. Handlers write to this file inline:
# a helper called from inside a dispatcher handler is not guaranteed to resolve.
try {
    if ((Test-Path $DiagFile) -and (Get-Item $DiagFile).Length -gt 200KB) {
        (Get-Content $DiagFile -Tail 200) | Set-Content $DiagFile -Encoding UTF8
    }
} catch { }
function Write-Diag($msg) {
    try { [IO.File]::AppendAllText($DiagFile, ('{0} {1}{2}' -f (Get-Date -Format 's'), $msg, [Environment]::NewLine), [Text.Encoding]::UTF8) } catch { }
}

# Single instance. The strip is started from three places (Startup shortcut, the
# watchdog task, and by hand), so the guard lives here rather than in any of the
# launchers: whoever loses the race exits before drawing anything.
# Creating the object is inside the try as well: when the name is already owned
# by a token we may not touch, the constructor throws UnauthorizedAccessException
# and $ErrorActionPreference='Stop' killed the process here without a word, while
# the watchdog kept logging «запуск НЕ ПОДТВЕРЖДЁН» forever.
$got = $false
try {
    $script:Mutex = New-Object System.Threading.Mutex($false, 'Global\CCUsageWidget')
    # WaitOne throws AbandonedMutexException when the previous owner was killed
    # instead of exiting cleanly. That means the mutex IS ours now, not that
    # another strip is running - swallowing it is what lets the watchdog revive
    # the strip after a crash or a Stop-Process.
    try { $got = $script:Mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $got = $true }
} catch {
    Write-Diag "мьютекс недоступен: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    exit 3
}
if (-not $got) { exit 0 }

# «Выход» must hold across a relaunch from the Startup shortcut too - the flag
# was only ever read by the watchdog, so any manual or logon start put the strip
# back on screen the user had just dismissed.
try {
    if (Test-Path $OffFlag) {
        $key = Get-SessionKey
        $inFlag = (Get-Content $OffFlag -Raw -ErrorAction SilentlyContinue)
        if ($inFlag) { $inFlag = $inFlag.Trim() }
        if ($key -and $inFlag -eq $key) { Write-Diag 'старт отменён: widget_off.flag этой сессии'; exit 0 }
    }
} catch { }

Add-Type @"
using System; using System.Runtime.InteropServices;
public class TB {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(
      IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool MoveFileEx(
      string src, string dst, uint flags);
  public struct R { public int L, T, Rt, B; }
  public struct P { public int X, Y; public P(int x, int y) { X = x; Y = y; } }
  // IsWindowVisible only says the WS_VISIBLE bit is set: a window parked past the
  // edge of the desktop, or collapsed to nothing, passes it while the user sees
  // no strip at all. The heartbeat must mean «visible», so it also measures.
  public static bool OnScreen(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h) || !IsWindowVisible(h)) return false;
    R r; if (!GetWindowRect(h, out r)) return false;
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
    int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    return Overlaps(r, vx, vy, vw, vh);
  }
  // split out so it can be tested without a window: overlap, not edge position.
  // The strip lives on the taskbar, so its top edge is always within a hair of
  // the bottom of the desktop and an edge test calls it off-screen.
  public static bool Overlaps(R r, int vx, int vy, int vw, int vh) {
    if (vw <= 0 || vh <= 0) return true;   // metrics unavailable: do not lie either way
    if (r.Rt - r.L < 40 || r.B - r.T < 8) return false;
    int ox = Math.Min(r.Rt, vx + vw) - Math.Max(r.L, vx);
    int oy = Math.Min(r.B, vy + vh) - Math.Max(r.T, vy);
    return ox >= 40 && oy >= 8;
  }
  // Being inside the desktop rectangle is not being seen. The Windows 11 taskbar
  // is topmost too, and the strip slid underneath it: window alive, rectangle
  // correct, heartbeat ticking, nothing visible. Ask the compositor whose pixels
  // are actually on top along the strip's centre line. Returns 0..5, or -1 when
  // there is no window to measure.
  public static int Uncovered(IntPtr h) {
    R r; if (h == IntPtr.Zero || !IsWindow(h) || !GetWindowRect(h, out r)) return -1;
    int w = r.Rt - r.L, ht = r.B - r.T;
    if (w < 8 || ht < 4) return -1;
    int y = r.T + ht / 2, seen = 0;
    for (int i = 1; i <= 9; i += 2) {
      IntPtr hit = WindowFromPoint(new P(r.L + (w * i) / 10, y));
      if (hit != IntPtr.Zero && (hit == h || GetAncestor(hit, 2) == h)) seen++;
    }
    return seen;
  }
  // Topmost is a WPF DependencyProperty and the OS never clears it, so «if the
  // property is false, set it» could not fire even once. Re-inserting the window
  // at the head of the topmost band is the only thing that actually restores
  // z-order. SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE: no move, no focus stolen.
  public static void Raise(IntPtr h) {
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
  }
  // MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH. The watchdog kills this
  // process with -Force, and a Set-Content interrupted mid-write left a zero-byte
  // widget_pos.json, which parsed as null and parked the strip at 0,0 forever.
  public static bool AtomicMove(string src, string dst) { return MoveFileEx(src, dst, 0x1 | 0x8); }
}
"@

# --- palette -------------------------------------------------------------
# Colour never carries meaning alone: every state also changes a word in the
# failure slot, so the readout survives peripheral vision and colour blindness.
$Palette = @{
  text  = '#C8D3DC'   # neutral fact
  ok    = '#7FD1B9'   # within budget
  warn  = '#E8B84B'   # will overshoot / data ageing
  hot   = '#FF6B5E'   # over the limit / quota nearly gone / blind
  blue  = '#6FA8FF'   # forecast that fits under the limit
  bar   = '#8A97A2'   # fact bar while the fact is far from the limit
  ghostOk  = '#2A3F66'   # forecast ghost, fits
  ghostHot = '#5A2420'   # forecast ghost, over
  spike = '#FF9E4A'   # a burst is happening right now
  dim   = '#5A6672'   # nothing is burning
  mute  = '#6E7A85'   # not enough data to say
  ink   = '#101418'   # text on top of an inverted slot
}

# --- ui ------------------------------------------------------------------
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize"
        SizeToContent="WidthAndHeight" Title="CC Usage">
  <Border x:Name="Root" CornerRadius="6" Padding="9,2" Background="#CC101418"
          BorderBrush="#33FFFFFF" BorderThickness="1">
    <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
      <!-- failure channel: a word, and an inverted block behind it -->
      <TextBlock x:Name="TxtFlag" FontFamily="Consolas" FontSize="13" FontWeight="Bold"
                 Padding="3,0" Margin="0,0,4,0" VerticalAlignment="Center"/>
      <!-- 5h bar: bright part is spent, the ghost behind it is the forecast -->
      <Grid Width="110" Height="10" VerticalAlignment="Center" Margin="0,0,4,0">
        <Border CornerRadius="2" Background="#1E262D"/>
        <Rectangle x:Name="Bar5Proj" HorizontalAlignment="Left" Width="0"/>
        <Rectangle x:Name="Bar5Fact" HorizontalAlignment="Left" Width="0"/>
      </Grid>
      <!-- the fact: last server measurement, with ~ when carried forward -->
      <TextBlock x:Name="TxtNow" FontFamily="Consolas" FontSize="13"
                 VerticalAlignment="Center"/>
      <!-- pace, drawn as the arrow from the fact to the forecast -->
      <TextBlock x:Name="TxtRate" FontFamily="Consolas" FontSize="12"
                 VerticalAlignment="Center"/>
      <!-- forecast at reset, or what is missing instead of it -->
      <TextBlock x:Name="TxtPct" FontFamily="Consolas" FontSize="13" FontWeight="Bold"
                 VerticalAlignment="Center"/>
      <!-- how long until the 5h window resets -->
      <TextBlock x:Name="TxtLeft" FontFamily="Consolas" FontSize="13"
                 VerticalAlignment="Center"/>
      <Rectangle Width="1" Height="14" Fill="#3A4550" Margin="6,0" VerticalAlignment="Center"/>
      <!-- weekly quota: the other budget, which no pace can fix in one window -->
      <TextBlock Text="нед " FontFamily="Consolas" FontSize="12" Foreground="#6E7A85"
                 VerticalAlignment="Center"/>
      <Grid Width="70" Height="10" VerticalAlignment="Center" Margin="0,0,4,0">
        <Border CornerRadius="2" Background="#1E262D"/>
        <Rectangle x:Name="BarWkFact" HorizontalAlignment="Left" Width="0"/>
      </Grid>
      <TextBlock x:Name="TxtWeek" FontFamily="Consolas" FontSize="13"
                 VerticalAlignment="Center"/>
    </StackPanel>
  </Border>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$win    = [Windows.Markup.XamlReader]::Load($reader)
$tFlag = $win.FindName('TxtFlag')
$tNow  = $win.FindName('TxtNow')
$tPct  = $win.FindName('TxtPct')
$tRate = $win.FindName('TxtRate')
$tWeek = $win.FindName('TxtWeek')
$tLeft = $win.FindName('TxtLeft')
$b5Proj = $win.FindName('Bar5Proj'); $b5Fact = $win.FindName('Bar5Fact')
$bWkFact = $win.FindName('BarWkFact')

$script:Brushes = @{}
function New-Brush($hex) {
    if (-not $script:Brushes.ContainsKey($hex)) {
        $b = (New-Object Windows.Media.BrushConverter).ConvertFromString($hex)
        $b.Freeze()
        $script:Brushes[$hex] = $b
    }
    $script:Brushes[$hex]
}

# The collector renames data.json into place. A plain Get-Content holds the file
# without FILE_SHARE_DELETE and made that rename fail (EPERM in the service log),
# so read with sharing and retry the microsecond-wide race instead.
function Read-Data {
    for ($i = 0; $i -lt 3; $i++) {
        try {
            $fs = [System.IO.File]::Open($DataFile, [System.IO.FileMode]::Open,
                  [System.IO.FileAccess]::Read,
                  [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
            try {
                $sr = New-Object System.IO.StreamReader($fs)
                $txt = $sr.ReadToEnd()
                $sr.Dispose()
            } finally { $fs.Dispose() }
            if ($txt) { return $txt | ConvertFrom-Json }
        } catch { Start-Sleep -Milliseconds 20 }
    }
    return $null
}

function Format-Tokens($n) {
    if ($null -eq $n) { return '--' }
    if ($n -ge 1e9) { '{0:N1}B' -f ($n / 1e9) }
    elseif ($n -ge 1e6) { '{0:N1}M' -f ($n / 1e6) }
    elseif ($n -ge 1e3) { '{0:N0}K' -f ($n / 1e3) }
    else { "$n" }
}

# Slot writers. The text arrives already fitted by fmt.ps1; Fit here is the second
# and final guard so no branch can shift the grid.
function Set-Slot($tb, $text, $slot, $fg, $bg) {
    $tb.Text = Fit $slot $text
    $tb.Foreground = New-Brush $fg
    if ($bg) { $tb.Background = New-Brush $bg } else { $tb.Background = $null }
}

# Bars: width is the percent of the limit, capped at the bar. A forecast past
# 100 fills the whole track with the red ghost - the number beside it says how far.
function Set-Bar($rect, $full, $pct, $hex) {
    $p = ConvertTo-DoubleOrNull $pct
    if ($null -eq $p -or $p -le 0 -or -not $hex) { $rect.Width = 0; return }
    $rect.Width = [math]::Round($full * [math]::Min($p, 100) / 100)
    $rect.Fill = New-Brush $hex
}

$script:Blink = $false
$script:BlinkOn = $true
$script:Covered = $false
$script:CoverTicks = 0
# «Перезапустить» dims the strip until the watchdog closes it; the tick would
# otherwise put full opacity back within 5 s and the press would look ignored
$script:DimUntil = [datetime]::MinValue

function Update-Ui {
    $d = Read-Data
    $blk = if ($d) { $d.block } else { $null }

    # --- how old is the collector itself ----------------------------------
    # Its silence used to be invisible: the strip kept redrawing numbers from a
    # file nobody was writing any more.
    $dataAge = 999
    if ($d -and $d.updatedAt) {
        try {
            $dataAge = [int]((Get-Date).ToUniversalTime() -
                             [datetime]::Parse($d.updatedAt, $null, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()).TotalSeconds
        } catch { $dataAge = 999 }
    }

    # --- д: the collector is dead ------------------------------------------
    if (-not $d -or -not $blk -or $dataAge -gt $DeadSec) {
        Set-Slot $tFlag (Format-SlotM 'СТОП') M $Palette.ink $Palette.hot
        # the same formatters as the live branch: this literal used to be one
        # character short and pulled «--» a column left
        Set-Slot $tNow  (Format-SlotA $null ' ') A $Palette.hot $null
        Set-Slot $tPct  (Fit B 'сбор --')        B $Palette.hot $null
        Set-Bar $b5Proj 110 $null $null; Set-Bar $b5Fact 110 $null $null; Set-Bar $bWkFact 70 $null $null
        Set-Slot $tRate (Format-SlotS $null)     S $Palette.hot $null
        Set-Slot $tWeek (Format-SlotD $null)     D $Palette.hot $null
        Set-Slot $tLeft (Format-SlotE $null)     E $Palette.hot $null
        $script:Blink = $true
        $win.Opacity = if ((Get-Date) -lt $script:DimUntil) { 0.35 } else { 1.0 }
        $win.ToolTip = if ($d) { "коллектор молчит $dataAge с`nсервис CCWidgetCollector" }
                       else { "нет данных: $DataFile" }
        return
    }

    $state = $blk.state
    $trust = if ($blk.trust) { $blk.trust } else { 'blind' }
    # null is not zero: srvAgeMin missing means «unknown», remainingMin missing
    # means «no idea when it resets», and both used to print as a confident number
    $srvAge  = ConvertTo-IntOrNull $blk.srvAgeMin
    $resetIn = ConvertTo-IntOrNull $blk.remainingMin
    if ($null -ne $resetIn -and $resetIn -lt 0) { $resetIn = 0 }
    # The server can say no 5h window is open at all; then there is nothing to
    # count down and the collector's endsAt is an assumption, not a reset time.
    # Showing it drew a confident «ост 0:06» over a window that had already gone.
    $notStarted = ($blk.windowNotStarted -eq $true)
    if ($notStarted) { $resetIn = $null }
    $script:Blink = $false

    # --- slot M + slot A: the fact -----------------------------------------
    # Blind and stale show the last SERVER number, never the extrapolation, and
    # say so in a word. Dimming was the old signal and it read as "all quiet";
    # what cannot be trusted is now louder, not quieter.
    $flag = '5ч'; $flagFg = $Palette.mute; $flagBg = $null
    switch ($trust) {
        'blind' { $flag = 'СЛЕП'; $flagFg = $Palette.ink; $flagBg = $Palette.hot;  $script:Blink = $true }
        'stale' { $flag = 'СТАР'; $flagFg = $Palette.ink; $flagBg = $Palette.warn }
        default {
            if ($state -eq 'idle') { $flag = 'ПАУЗ'; $flagFg = $Palette.dim; $flagBg = $null }
        }
    }
    Set-Slot $tFlag (Format-SlotM $flag) M $flagFg $flagBg

    $blind = ($trust -eq 'blind')
    $shownPct = if ($blind) { $null }
                elseif ($trust -eq 'stale') { ConvertTo-IntOrNull $blk.realPctSrv }
                else { ConvertTo-IntOrNull $blk.realPct }
    $mark = if ($trust -eq 'extrap') { '~' } else { ' ' }
    # Colour of a number is its distance to the limit and nothing else: yellow
    # from 75, red from 90. An untrusted number is grey - the flag in M says why.
    $aFg = if ($null -eq $shownPct)    { $Palette.mute }
           elseif ($trust -eq 'stale') { $Palette.mute }
           elseif ($shownPct -ge 90)   { $Palette.hot }
           elseif ($shownPct -ge 75)   { $Palette.warn }
           else                        { $Palette.text }
    Set-Slot $tNow (Format-SlotA $shownPct $mark) A $aFg $null

    # --- slot B: the forecast band, or the reason there is none -------------
    # The band the inputs justify is real, but it is not what the strip is for:
    # one glance, one number. The range moved to the tooltip, and the colour is
    # still taken from its upper end so the warning fires as early as before.
    $bTxt = ''; $bFg = $Palette.mute
    # «нет окна» is a statement about the quota, not about the endpoint, and it
    # outranks both: it used to sit below $blind, which is exactly the state every
    # window boundary landed in, so the branch never once ran.
    if ($notStarted) {
        $bTxt = Format-SlotBNoWindow; $bFg = $Palette.dim
    } elseif ($blind) {
        $bTxt = Format-SlotBServer; $bFg = $Palette.mute
    } elseif ($trust -eq 'stale') {
        $bTxt = Format-SlotBStale $srvAge; $bFg = $Palette.mute
    } elseif ($null -eq $shownPct) {
        # trust says fact/extrap but the number itself is gone (NaN in the
        # collector arrives here as null): say so instead of forecasting from it
        $bTxt = Format-SlotBNoNumber; $bFg = $Palette.hot; $script:Blink = $true
    } elseif ($state -eq 'idle') {
        $bTxt = Format-SlotBIdle; $bFg = $Palette.dim
    } elseif ($state -eq 'cold' -or $null -eq $blk.realProjPct) {
        $bTxt = Format-SlotBCold; $bFg = $Palette.mute
    } elseif ($shownPct -ge 100) {
        $bTxt = Format-SlotBLimit; $bFg = $Palette.hot
    } else {
        $lo = if ($null -ne $blk.realProjLo) { $blk.realProjLo } else { $blk.realProjPct }
        $hi = if ($null -ne $blk.realProjHi) { $blk.realProjHi } else { $blk.realProjPct }
        $bTxt = Format-SlotBOne $blk.realProjPct
        # Red over the limit, blue under it, judged on the printed number: a
        # «95%» in red would contradict itself. The band stays in the tooltip.
        $projI = ConvertTo-IntOrNull $blk.realProjPct
        # frozen is a quiet pause, not old data: its forecast is just as real
        $bFg = if ($null -eq $projI)     { $Palette.mute }
               elseif ($projI -gt 100)   { $Palette.hot }
               else                      { $Palette.blue }
    }
    Set-Slot $tPct $bTxt B $bFg $null

    # --- 5h bar: the fact over the forecast ghost ----------------------------
    # Blind still draws the last server number, in grey: a bar that empties on
    # every hiccup would read as «nothing spent».
    $factBar = if ($blind) { ConvertTo-IntOrNull $blk.realPctSrv } else { $shownPct }
    $factHex = if ($blind -or $null -eq $shownPct -or $trust -eq 'stale') { $Palette.dim }
               elseif ($shownPct -ge 90) { $Palette.hot }
               elseif ($shownPct -ge 75) { $Palette.warn }
               else { $Palette.bar }
    Set-Bar $b5Fact 110 $factBar $factHex
    if ($bFg -eq $Palette.hot -and $shownPct -ge 100) { Set-Bar $b5Proj 110 100 $Palette.ghostHot }
    elseif ($bFg -eq $Palette.hot)  { Set-Bar $b5Proj 110 $blk.realProjPct $Palette.ghostHot }
    elseif ($bFg -eq $Palette.blue) { Set-Bar $b5Proj 110 $blk.realProjPct $Palette.ghostOk }
    else { Set-Bar $b5Proj 110 $null $null }

    # --- slot S: pace, in percent of the limit per hour ---------------------
    # This is the pace the forecast beside it was built from, not the raw server
    # slope: with 20 % spent and 4.5 h left, pctPerHour 18.7 gives the 105 % in
    # slot B, while srvPctPerHour 44.2 gives 221 % - the upper end of the band.
    # Showing the second next to the first would make two neighbouring cells
    # disagree about the same window. The server slope stays in the tooltip and
    # still drives the colour of B. Colour here is against the BUDGET pace - the
    # percent per hour that lands exactly on 100 at the reset - because 18 %/ч
    # is calm with four hours left and fatal with forty minutes.
    $rate = if ($null -ne $blk.pctPerHour) { ConvertTo-DoubleOrNull $blk.pctPerHour }
            else { ConvertTo-DoubleOrNull $blk.srvPctPerHour }
    if ($blind -or $trust -eq 'stale' -or $notStarted) { $rate = $null }
    # The window is too young to have a pace at all: slot B says «замер…» there,
    # and a number beside it would be the same guess wearing a different hat.
    elseif ($state -eq 'cold') { $rate = $null }
    elseif ($state -eq 'idle') { $rate = 0 }
    $budget = if ($null -ne $resetIn -and $resetIn -gt 0 -and $null -ne $shownPct) {
                  [math]::Max(0, (100 - $shownPct)) / ($resetIn / 60)
              } else { $null }
    # Grey always: the pace is the arrow to the forecast, and the forecast's
    # colour already says whether this pace fits.
    $sFg = if ($null -eq $rate -or $rate -le 0) { $Palette.dim } else { $Palette.mute }
    Set-Slot $tRate (Format-SlotS $rate) S $sFg $null

    # --- slot D: the weekly quota ------------------------------------------
    # The 5h field learned to print «--» once the server answer went stale. This
    # one kept printing its number in exactly the colour of a fresh one, so a
    # figure measured nine hours ago read as current. Marked while it is merely
    # old, dropped once the drift outgrows the digits. A number in the danger
    # bands keeps its red: a stale 91% is still a warning worth seeing.
    $wk = ConvertTo-IntOrNull $d.usage.weekPct
    $wkAge = ConvertTo-IntOrNull $d.usage.ageMin
    if ($null -eq $wkAge) { $wkAge = 99999 }
    if ($null -ne $wk -and $wkAge -gt $WeekBlindMin) { $wk = $null }
    # thresholds compare the number that is printed, not the one before rounding
    $dFg = if ($null -eq $wk) { $Palette.dim }
           elseif ($wk -ge 90) { $Palette.hot }
           elseif ($wk -ge 75) { $Palette.warn }
           elseif ($wkAge -gt 60) { $Palette.mute }
           else { $Palette.text }
    Set-Slot $tWeek (Format-SlotD $wk) D $dFg $null
    $wkHex = if ($null -eq $wk) { $null } elseif ($wk -ge 90) { $Palette.hot }
             elseif ($wk -ge 75) { $Palette.warn } elseif ($wkAge -gt 60) { $Palette.dim } else { $Palette.bar }
    Set-Bar $bWkFact 70 $wk $wkHex

    # --- slot E: time left in the window ------------------------------------
    # A duration, not a wall clock: "1:12 left" needs no arithmetic.
    # «no window yet» is a normal state, not a fault: it must not be red.
    $eFg = if ($notStarted) { $Palette.dim }
           elseif ($null -eq $resetIn) { $Palette.hot }
           elseif ($resetIn -le 20) { $Palette.ok }
           else { $Palette.dim }
    Set-Slot $tLeft (Format-SlotE $resetIn) E $eFg $null

    # Only a genuine pause is dimmed. Everything else stays at full contrast,
    # including - especially - the states where the numbers are missing.
    $win.Opacity = if ((Get-Date) -lt $script:DimUntil) { 0.35 }
                   elseif ($state -eq 'idle' -and -not $blind) { 0.6 } else { 1.0 }

    # --- tooltip ------------------------------------------------------------
    $tip = "Claude Code ($($d.plan))`n"
    $srvAgeTxt = if ($null -eq $srvAge) { '?' } else { "$srvAge" }
    $tip += switch ($trust) {
        'fact'   { "Замер сервера $srvAgeTxt мин назад`n" }
        'extrap' { "Сервер $($blk.realPctSrv)% $srvAgeTxt мин назад + локальный расход`n" }
        'stale'  { "Замер устарел ($srvAgeTxt мин) — экстраполяция снята`n" }
        default  { $err = "$($d.usage.error)"
                   if ($err.Length -gt 120) { $err = $err.Substring(0, 120) + '…' }
                   "Сервер не отвечает: $err`n" }
    }
    if ($d.usage.retryAt) {
        # the button asks for a poll now only over a network failure; a pause the
        # server asked for (429/5xx/401) stands, so do not offer what will not happen
        $hint = if ($d.usage.netFail) { ' · ПКМ → Перезапустить' } else { ' — пауза по требованию сервера' }
        try { $tip += "Повтор опроса в $([datetime]::Parse($d.usage.retryAt).ToLocalTime().ToString('HH:mm'))$hint`n" } catch { }
    }
    $tip += switch ($state) {
        'idle'   { "○ пауза $([int]($blk.idleSec / 60)) мин — расход 0`n" }
        'frozen' { "◌ тихо $($blk.idleSec) с — темп заморожен`n" }
        'cold'   { "· мало данных в окне — темп ещё не считается`n" }
        default  { if ($blk.spike) { "⚡ рывок`n" }
                   elseif ($blk.trend -eq 'up') { "▲ разгон`n" }
                   elseif ($blk.trend -eq 'down') { "▼ торможение`n" }
                   else { "▬ ровный темп`n" } }
    }
    if ($blk.srvAnchor -eq 'birth') { $tip += "Отсчёт от начала окна (0 %): сервер ещё не замерял это окно`n" }
    if ($blk.perPctSrc -eq 'cold') { $tip += "Курс токены→% — средний по прошлым окнам, не по этому`n" }
    if ($null -ne $blk.pctPerHour) { $tip += "Темп: $($blk.pctPerHour)% лимита в час`n" }
    if ($null -ne $blk.srvPctPerHour) {
        $tip += "Темп по серверу: $($blk.srvPctPerHour)%/ч (замеров $($blk.srvSamples))`n"
    } elseif ($null -ne $blk.srvSamples) {
        $tip += "Серверных замеров в окне: $($blk.srvSamples) (наклон с 4)`n"
    }
    if ($null -ne $blk.realProjLo) { $tip += "К сбросу: $($blk.realProjLo)–$($blk.realProjHi)%`n" }
    if ($null -ne $blk.realEtaMin -and $blk.realEtaMin -gt 0 -and $null -ne $resetIn -and $blk.realEtaMin -lt $resetIn -and $blk.realEtaAt) {
        try { $tip += "Упрёмся в лимит примерно в $([datetime]::Parse($blk.realEtaAt).ToLocalTime().ToString('HH:mm'))`n" } catch { }
    }
    $tip += if ($null -eq $resetIn) { "Когда сброс — неизвестно`n" } else { "Сброс через $resetIn мин`n" }
    $tip += "Расход: $(Format-Tokens $blk.costPerHour)/ч`n"
    if ($d.logsUnavailable) { $tip += "ЛОГИ НЕДОСТУПНЫ — расход не считается`n" }
    if ($null -ne $wkAge -and $wkAge -lt 99999) { $tip += "Ответ сервера: $wkAge мин назад`n" }
    if ($script:Covered) { $tip += "Полоску перекрывает чужое окно — возвращаю наверх`n" }
    $tip += "Данные коллектора: $dataAge с назад"
    $win.ToolTip = $tip
}

# --- placement -----------------------------------------------------------
<#
 Pulls the window back onto a visible monitor. A saved position becomes a
 trap when the laptop comes back from a dock with fewer screens or a different
 resolution: the widget is then "running" but nobody can see it.
#>
function Set-OnScreen {
    $w = if ($win.ActualWidth -gt 0) { $win.ActualWidth } else { 200 }
    $h = if ($win.ActualHeight -gt 0) { $win.ActualHeight } else { 24 }
    $vx = [Windows.SystemParameters]::VirtualScreenLeft
    $vy = [Windows.SystemParameters]::VirtualScreenTop
    $vw = [Windows.SystemParameters]::VirtualScreenWidth
    $vh = [Windows.SystemParameters]::VirtualScreenHeight
    if ([double]::IsNaN($win.Left) -or [double]::IsNaN($win.Top)) { return $false }
    # Overlap with the desktop, not the position of an edge. The old edge test
    # («top must be 40 px above the bottom») was false for every strip parked on
    # the taskbar, so the 3 s keep-top timer re-ran Set-DefaultPosition forever
    # and any position the user dragged the strip to was silently discarded.
    $ox = [Math]::Min($win.Left + $w, $vx + $vw) - [Math]::Max($win.Left, $vx)
    $oy = [Math]::Min($win.Top  + $h, $vy + $vh) - [Math]::Max($win.Top,  $vy)
    return ($ox -ge 40 -and $oy -ge 8)
}

# The tray rect comes back in physical pixels while Left/Top are device
# independent units. At 150 % scaling that pushed the strip a third of a screen
# off to the right, and the on-screen check then dragged it back every 3 s.
function Get-DipScale {
    try {
        $src = [System.Windows.PresentationSource]::FromVisual($win)
        if ($src -and $src.CompositionTarget) {
            $m = $src.CompositionTarget.TransformToDevice
            if ($m.M11 -gt 0) { return $m.M11 }
        }
    } catch { }
    return 1.0
}

function Set-DefaultPosition {
    $s = Get-DipScale
    $h = [TB]::FindWindow('Shell_TrayWnd', $null)
    $r = New-Object TB+R
    if ($h -ne [IntPtr]::Zero -and [TB]::GetWindowRect($h, [ref]$r)) {
        $win.Left = ($r.Rt / $s) - $win.ActualWidth - 320
        $win.Top  = ($r.T / $s) + ((($r.B - $r.T) / $s) - $win.ActualHeight) / 2
    } else {
        $win.Left = ([Windows.SystemParameters]::PrimaryScreenWidth - $win.ActualWidth - 320)
        $win.Top  = ([Windows.SystemParameters]::PrimaryScreenHeight - $win.ActualHeight - 8)
    }
}

$win.Add_SourceInitialized({
    Update-Ui
    $win.UpdateLayout()
    # An empty or BOM-only widget_pos.json does not throw: ConvertFrom-Json just
    # returns null, $win.Left = $null becomes 0, and the strip lived in the top
    # left corner for good. Only a pair of real numbers counts as a position.
    $placed = $false
    if (Test-Path $PosFile) {
        try {
            $raw = [IO.File]::ReadAllText($PosFile)
            if ($raw -and $raw.Trim().Length -gt 1) {
                $p = $raw | ConvertFrom-Json
                $l = ConvertTo-DoubleOrNull $p.left
                $t = ConvertTo-DoubleOrNull $p.top
                if ($null -ne $l -and $null -ne $t) { $win.Left = $l; $win.Top = $t; $placed = $true }
            }
        } catch { Write-Diag "widget_pos.json не прочитан: $($_.Exception.Message)" }
        if (-not $placed) { Write-Diag 'widget_pos.json пуст или битый -> позиция по умолчанию' }
    }
    if (-not $placed) { Set-DefaultPosition }
    if (-not (Set-OnScreen)) { Set-DefaultPosition }
})

# drag to move, position remembered. Written to a temp file and renamed over the
# old one: the watchdog kills this process with -Force and a half-written file is
# what put the strip at 0,0.
$win.Add_MouseLeftButtonDown({ $win.DragMove() })
$win.Add_MouseLeftButtonUp({
    try {
        $inv = [Globalization.CultureInfo]::InvariantCulture
        $tmp = $PosFile + '.tmp'
        [IO.File]::WriteAllText($tmp, ('{{"left":{0},"top":{1}}}' -f $win.Left.ToString($inv), $win.Top.ToString($inv)))
        if (-not [TB]::AtomicMove($tmp, $PosFile)) {
            [IO.File]::AppendAllText($DiagFile, ('{0} позиция не сохранена (MoveFileEx){1}' -f (Get-Date -Format 's'), [Environment]::NewLine), [Text.Encoding]::UTF8)
        }
    } catch { }
})

# right-click menu
$menu = New-Object Windows.Controls.ContextMenu
# «Перезапустить» only asks. The collector is a LocalSystem service and this
# window may be the thing that is broken, so restart.vbs drops a flag and starts
# the elevated watchdog task, which restarts both and asks for one poll now.
$miRestart = New-Object Windows.Controls.MenuItem; $miRestart.Header = 'Перезапустить   Ctrl+Alt+W'
$miRestart.Add_Click({
    try {
        Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\wscript.exe') `
                      -ArgumentList ('"' + (Join-Path $Root 'restart.vbs') + '"') -ErrorAction Stop
        # the only feedback there is time for: the watchdog closes this window next
        $script:DimUntil = (Get-Date).AddSeconds(30)
        $win.Opacity = 0.35
    } catch { Write-Diag "перезапуск не запущен: $($_.Exception.Message)" }
})
$miReset = New-Object Windows.Controls.MenuItem; $miReset.Header = 'Вернуть к трею'
$miReset.Add_Click({ Set-DefaultPosition; Remove-Item $PosFile -ErrorAction SilentlyContinue })
# «Выход» used to be a lie: the watchdog put the strip back within two minutes.
# The flag file is what the watchdog checks, so leaving actually leaves - and it
# now carries the logon session it belongs to, because Fast Startup keeps
# LastBootUpTime frozen and turned «до перезагрузки» into «навсегда».
$miExit = New-Object Windows.Controls.MenuItem; $miExit.Header = 'Выход (до конца сеанса)'
$miExit.Add_Click({
    try {
        $key = Get-SessionKey
        if (-not $key) { $key = 'boot|' + (Get-Date -Format 'o') }
        [IO.File]::WriteAllText($OffFlag, $key)
    } catch { }
    $win.Close()
})
$menu.Items.Add($miRestart) | Out-Null
$menu.Items.Add($miReset) | Out-Null
$menu.Items.Add($miExit)  | Out-Null
$win.ContextMenu = $menu

# Liveness is not «the process exists». The strip once sat there for minutes with
# a live process, a held mutex and no window at all: the dispatcher handler below
# swallows every exception, so a broken UI looks exactly like a healthy one from
# outside. The heartbeat is written only when a window is actually on screen AND
# the last draw succeeded - a beat after a failed Update-Ui froze the slots while
# the watchdog read perfect health. It carries the PID so the watchdog can kill
# the right copy instead of guessing by age.
# refresh loop
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(5)
$timer.Add_Tick({
    $drew = $false
    try { Update-Ui; $drew = $true }
    catch {
        try { [IO.File]::AppendAllText($DiagFile, ('{0} Update-Ui упал: {1}{2}' -f (Get-Date -Format 's'), $_.Exception.Message, [Environment]::NewLine), [Text.Encoding]::UTF8) } catch { }
    }
    # Written inline rather than through a helper: a function call from inside a
    # dispatcher handler resolves in a session state that does not carry this
    # script's functions, and the failure is swallowed by the handler below.
    try {
        $h = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
        if ($drew -and $win.IsVisible -and [TB]::OnScreen($h)) {
            [IO.File]::WriteAllText($BeatFile, ('{{"ts":"{0}","pid":{1},"covered":{2}}}' -f
                (Get-Date -Format 'o'), $PID, $script:Covered.ToString().ToLower()))
        }
    } catch { }
})
# an unhandled exception anywhere else would take the strip down silently
[Windows.Threading.Dispatcher]::CurrentDispatcher.Add_UnhandledException({
    param($s, $e)
    try { [IO.File]::AppendAllText($DiagFile, ('{0} DISPATCHER: {1}{2}' -f (Get-Date -Format 's'), $e.Exception.Message, [Environment]::NewLine), [Text.Encoding]::UTF8) } catch { }
    $e.Handled = $true
})
$timer.Start()

# 1 Hz blink, and only for the two states that demand an action: no server
# answer at all, or no collector. A blink that fires for everything is ignored.
$blinker = New-Object Windows.Threading.DispatcherTimer
$blinker.Interval = [TimeSpan]::FromMilliseconds(500)
$blinker.Add_Tick({
    try {
        if ($script:Blink) {
            $script:BlinkOn = -not $script:BlinkOn
            $tFlag.Opacity = if ($script:BlinkOn) { 1.0 } else { 0.35 }
        } elseif ($tFlag.Opacity -ne 1.0) { $tFlag.Opacity = 1.0 }
    } catch { }
})
$blinker.Start()

# Stay above the taskbar even when explorer or another topmost window takes the
# top of the band. The old guard («if Topmost is false, set it») could never fire:
# Topmost is a DependencyProperty and the OS does not clear it. What is measured
# now is whose pixels are on top; SetWindowPos is what actually fixes it.
$keepTop = New-Object Windows.Threading.DispatcherTimer
$keepTop.Interval = [TimeSpan]::FromSeconds(3)
$keepTop.Add_Tick({
    try {
        $h = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
        $vis = [TB]::Uncovered($h)
        if ($vis -ge 0 -and $vis -lt 3) {
            $script:CoverTicks++
            # Fight for the first three ticks, then once a minute, and give up
            # after five minutes of unbroken cover: at that point it is not an
            # accident, it is a full-screen window the user is looking at, and
            # an overlay that keeps clawing back on top of a film is worse than
            # a missing overlay. Diagnostics only on the transitions, or the
            # log would grow a line a minute for as long as the cover lasts.
            if ($script:CoverTicks -le 3 -or (($script:CoverTicks % 20) -eq 0 -and $script:CoverTicks -le 100)) {
                [TB]::Raise($h)
                if ($script:CoverTicks -eq 1) {
                    [IO.File]::AppendAllText($DiagFile, ('{0} перекрыта ({1}/5 точек видно) -> z-order восстановлен{2}' -f (Get-Date -Format 's'), $vis, [Environment]::NewLine), [Text.Encoding]::UTF8)
                }
            } elseif ($script:CoverTicks -eq 101) {
                [IO.File]::AppendAllText($DiagFile, ('{0} перекрыта уже 5 мин — уступаю, подъём прекращён до освобождения{1}' -f (Get-Date -Format 's'), [Environment]::NewLine), [Text.Encoding]::UTF8)
            }
            $script:Covered = $true
        } else {
            $script:CoverTicks = 0
            $script:Covered = $false
        }
        if (-not (Set-OnScreen)) { Set-DefaultPosition }
    } catch { }
})
$keepTop.Start()

# the first beat must not wait for the first 5 s tick, or the watchdog would see
# a brand new strip as a stale one
$win.Add_ContentRendered({
    try {
        $h = (New-Object System.Windows.Interop.WindowInteropHelper($win)).Handle
        [TB]::Raise($h)
        if ($win.IsVisible -and [TB]::OnScreen($h)) {
            [IO.File]::WriteAllText($BeatFile, ('{{"ts":"{0}","pid":{1},"covered":false}}' -f (Get-Date -Format 'o'), $PID))
        }
    } catch { }
})
$win.ShowDialog() | Out-Null
# the window is gone; leaving a stale beat behind would make the corpse look alive
try { Remove-Item $BeatFile -Force -ErrorAction SilentlyContinue } catch { }
