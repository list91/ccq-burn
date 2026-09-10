#requires -version 5
# The one place the slot formats live. Both widget.ps1 and fmt_test.ps1 dot-source
# this file, so the test cannot drift from the strip: there is no second copy of a
# format string to drift from. Text cells: M(4) A(5) S(9) B(9) E(5) D(4) = 36 Consolas
# cells; the two bars and the «нед» caption sit between them in widget.ps1.
#   [5ч  ][▓▓▓░░░][ 25%~][› 18%/ч›][132%     ][ 4:12] │ нед [▓▓▓▓░][ 80%]
$SlotWidths = @{ M = 4; A = 5; B = 9; S = 9; D = 4; E = 5 }
# Truncation keeps the grid at runtime, but in the test it means a format is wider
# than its slot - a bug to fix in the format, not to hide behind Substring.
$script:FitTruncated = 0

function Fit($slot, $text) {
    $w = $SlotWidths[$slot]
    $s = "$text"
    if ($s.Length -gt $w) { $script:FitTruncated++; $s = $s.Substring(0, $w) }
    return $s.PadRight($w)
}

# JSON.stringify turns NaN and Infinity into null, and [int]$null is silently 0:
# a number that went missing used to print as a trustworthy "0%". Here it stays
# null and every slot prints "--" instead. Rounding is away from zero, so 56.5
# is 57 both in the digits and in the colour thresholds.
function ConvertTo-IntOrNull($v) {
    if ($null -eq $v) { return $null }
    $d = 0.0
    try { $d = [double]$v } catch { return $null }
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $null }
    if ($d -gt 2147483000 -or $d -lt -2147483000) { return $null }
    return [int][math]::Round($d, [System.MidpointRounding]::AwayFromZero)
}

function ConvertTo-DoubleOrNull($v) {
    if ($null -eq $v) { return $null }
    $d = 0.0
    try { $d = [double]$v } catch { return $null }
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return $null }
    return $d
}

function Format-SlotM($word) { Fit M $word }

function Format-SlotA($pct, $mark) {
    $p = ConvertTo-IntOrNull $pct
    if ($null -eq $p) { return (Fit A '  -- ') }
    if ($p -lt -99) { $p = -99 }
    if ($p -gt 999) { $p = 999 }
    if (-not $mark) { $mark = ' ' }
    Fit A ('{0,3}%{1}' -f $p, $mark)
}

function Format-SlotBServer   { Fit B 'сервер-- ' }
function Format-SlotBIdle     { Fit B 'расход 0 ' }
function Format-SlotBCold     { Fit B 'замер…' }
function Format-SlotBLimit    { Fit B 'ЛИМИТ    ' }
function Format-SlotBNoNumber { Fit B 'нет числа' }
function Format-SlotBNoWindow { Fit B 'нет окна ' }

function Format-SlotBStale($srvAgeMin) {
    $a = ConvertTo-IntOrNull $srvAgeMin
    if ($null -eq $a) { return (Fit B 'замер ?м ') }
    if ($a -lt 0)  { $a = 0 }
    if ($a -gt 99) { $a = 99 }
    Fit B ('замер{0,2}м ' -f $a)
}

function Format-SlotBBand($lo, $hi) {
    $l = ConvertTo-IntOrNull $lo
    $h = ConvertTo-IntOrNull $hi
    if ($null -eq $l -and $null -eq $h) { return (Format-SlotBNoNumber) }
    if ($null -eq $l) { $l = $h }
    if ($null -eq $h) { $h = $l }
    if ($l -gt $h) { $t = $l; $l = $h; $h = $t }
    if ($l -lt 0) { $l = 0 }
    if ($h -lt 0) { $h = 0 }
    # "99+" inverted the band: 150-99+% reads as a top end below the bottom one.
    # The cap now says what it caps (199+) and the ceiling applies to the pair.
    $band = if ($h -gt 199) { if ($l -gt 199) { '>199%' } else { '{0}-199+' -f $l } }
            elseif ($l -eq $h) { '{0}%' -f $h }
            else { '{0}-{1}%' -f $l, $h }
    Fit B $(if ($band.Length -gt 7) { '{0,8} ' -f $band } else { '→{0,7} ' -f $band })
}

# One number, not a band: the user reads the strip at a glance, and a range
# costs three cells and a comparison to answer the only question it is asked.
# The band is not lost - it stays in the tooltip, and the colour below is still
# driven by the upper end, so the warning keeps its safety margin.
function Format-SlotBOne($pct) {
    $p = ConvertTo-IntOrNull $pct
    if ($null -eq $p) { return (Format-SlotBNoNumber) }
    if ($p -lt 0) { $p = 0 }
    # The forecast is printed as it is, past 100 too: «132%» says how far over,
    # which the old «>199%» cap and the «→» prefix only hinted at. The arrow now
    # lives in the pace slot on its left: fact ›pace› forecast reads as a sentence.
    $s = if ($p -gt 999) { '>999%' } else { '{0}%' -f $p }
    Fit B $s
}

# Pace, in percent of the limit per hour. Below ten the integer throws away the
# difference between "idling" and "half the budget an hour", so one decimal
# survives there and nowhere else - the slot is seven cells wide and "100.0%/ч"
# would not fit anyway.
function Format-SlotS($pph) {
    $p = ConvertTo-DoubleOrNull $pph
    if ($null -eq $p) { return (Fit S '   ›--/ч›') }
    if ($p -lt 0) { $p = 0 }
    if ($p -gt 999) { return (Fit S '›999%/ч›') }
    # The separator is pinned: the strip runs both as the user and as SYSTEM,
    # and a service profile does not share the desktop's culture. Without this
    # the same pace reads "0,4" in one process and "0.4" in the other.
    $s = if ($p -lt 10) { [math]::Round($p, 1).ToString('0.0', [Globalization.CultureInfo]::InvariantCulture) }
         else { '{0}' -f [int][math]::Round($p, [System.MidpointRounding]::AwayFromZero) }
    # right-aligned as a whole, so the arrow always touches its number
    Fit S (('›{0}%/ч›' -f $s).PadLeft(9))
}

function Format-SlotD($weekPct) {
    $w = ConvertTo-IntOrNull $weekPct
    if ($null -eq $w) { return (Fit D ' -- ') }
    if ($w -lt -99) { $w = -99 }
    if ($w -gt 999) { $w = 999 }
    Fit D ('{0,3}%' -f $w)
}

function Format-SlotE($remainingMin) {
    $m = ConvertTo-IntOrNull $remainingMin
    if ($null -eq $m) { return (Fit E '--') }
    if ($m -lt 0) { $m = 0 }
    # 600 minutes would render as "10:00", one cell too many, and truncation
    # prints a wrong number. A 5h window is never longer than 599 minutes:
    # anything above that is not data.
    if ($m -gt 599) { return (Fit E '--') }
    Fit E ('{0,-5}' -f ('{0}:{1:00}' -f [int][math]::Floor($m / 60), ($m % 60)))
}
