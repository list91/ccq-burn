#requires -version 5
# Регрессия ширины. Форматы НЕ дублируются: тест зовёт те же функции, что и
# полоска. Расхождение теста с кодом невозможно по построению.
#   powershell -NoProfile -ExecutionPolicy Bypass -File fmt_test.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot) 'src/fmt.ps1')
$bad = 0

function Check($slot, $text, $case) {
    $len = "$text".Length
    $ok = ($len -eq $SlotWidths[$slot])
    if (-not $ok) { $script:bad++ }
    '{0} {1} |{2}| {3} (нужно {4})  {5}' -f $(if ($ok) { 'ok  ' } else { 'ПЛОХО' }), $slot, $text, $len, $SlotWidths[$slot], $case
}

Write-Output '--- M ---'
foreach ($f in '    ', 'СТАР', 'СЛЕП', 'СТОП', 'ПАУЗ') { Check M (Format-SlotM $f) $f }

Write-Output '--- A: включая null, NaN, перебор ---'
foreach ($p in 0, 7, 27, 100, 999, 1000, 99999, -5, -250) {
    foreach ($m in ' ', '~') { Check A (Format-SlotA $p $m) "pct=$p mark=$m" }
}
Check A (Format-SlotA $null ' ') 'pct=null'
Check A (Format-SlotA ([double]::NaN) '~') 'pct=NaN'
Check A (Format-SlotA 'мусор' ' ') 'pct=строка'
Check A (Format-SlotA 56.5 ' ') 'pct=56.5 (округление от нуля)'

Write-Output '--- B ---'
Check B (Format-SlotBServer) 'сервер молчит'
Check B (Format-SlotBIdle) 'idle'
Check B (Format-SlotBCold) 'cold'
Check B (Format-SlotBLimit) 'лимит'
Check B (Format-SlotBNoNumber) 'числа нет'
Check B (Format-SlotBNoWindow) 'окно не открыто'
foreach ($age in 0, 11, 59, 99, 150, -100, $null) { Check B (Format-SlotBStale $age) "srvAge=$age" }
foreach ($pair in @(@(30,45), @(0,0), @(99,250), @(250,400), @(5,7), @(199,199), @(200,200), @(0,1000), @(45,30), @($null,$null), @(7,$null), @(-3,12))) {
    Check B (Format-SlotBBand $pair[0] $pair[1]) "band=$($pair[0])..$($pair[1])"
}

foreach ($one in 0, 7, 96, 107, 199, 200, 1000, -5, $null, 106.5) {
    Check B (Format-SlotBOne $one) "one=$one"
}

Write-Output '--- S ---'
foreach ($v in 0, 0.4, 2.35, 9.9, 10, 18.3, 99, 100, 999, 1000, -3, $null, 'мусор', ([double]::NaN)) {
    Check S (Format-SlotS $v) "pph=$v"
}

Write-Output '--- D ---'
foreach ($wp in 0, 52, 100, 999, 1500, $null, 89.6) { Check D (Format-SlotD $wp) "week=$wp" }

Write-Output '--- E ---'
foreach ($m in 0, 5, 76, 300, 599, 600, 1440, -7, $null) { Check E (Format-SlotE $m) "left=$m" }

Write-Output ''
if ($script:FitTruncated -gt 0) {
    Write-Output "ОБРЕЗОК БЫЛО: $($script:FitTruncated) — формат шире слота, чинить формат, а не Substring"
    $bad++
}
if ($bad -eq 0) { Write-Output "ВСЕ СЛОТЫ ДЕРЖАТ СЕТКУ (сумма $($SlotWidths.M + $SlotWidths.A + $SlotWidths.B + $SlotWidths.S + $SlotWidths.D + $SlotWidths.E))" }
else { Write-Output "СЛОМАНО: $bad"; exit 1 }