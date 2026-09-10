# regression: the heartbeat must mean "the user can see the strip".
# Generated shape mirrors widget.ps1; the C# below is copied from it verbatim.
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public class TBT {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  public struct R { public int L, T, Rt, B; }
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
}
"@
$fail = 0
function T($name, $got, $want) {
  if ($got -ne $want) { Write-Host "FAIL $name : $got != $want"; $script:fail++ }
  else { Write-Host "ok   $name" }
}
function Rect($l, $t, $r, $b) { $x = New-Object TBT+R; $x.L = $l; $x.T = $t; $x.Rt = $r; $x.B = $b; $x }
# a 1920x1200 desktop with the strip parked on the taskbar: the old edge test
# called this off-screen and the beat went silent while the strip was visible
T 'на панели задач' ([TBT]::Overlaps((Rect 1313 1165 1601 1187), 0, 0, 1920, 1200)) $true
T 'по центру'       ([TBT]::Overlaps((Rect 800 600 1088 622), 0, 0, 1920, 1200)) $true
T 'за правым краем' ([TBT]::Overlaps((Rect 1900 1165 2188 1187), 0, 0, 1920, 1200)) $false
T 'за нижним краем' ([TBT]::Overlaps((Rect 1313 1198 1601 1220), 0, 0, 1920, 1200)) $false
T 'свёрнуто в -32000' ([TBT]::Overlaps((Rect -32000 -32000 -31712 -31978), 0, 0, 1920, 1200)) $false
T 'нулевой размер'  ([TBT]::Overlaps((Rect 1313 1165 1313 1165), 0, 0, 1920, 1200)) $false
T 'слишком узко'    ([TBT]::Overlaps((Rect 1313 1165 1343 1187), 0, 0, 1920, 1200)) $false
T 'второй монитор слева' ([TBT]::Overlaps((Rect -1500 300 -1212 322), -1920, 0, 3840, 1200)) $true
T 'метрики недоступны' ([TBT]::Overlaps((Rect 1313 1165 1601 1187), 0, 0, 0, 0)) $true
if ($fail -eq 0) { Write-Host "`nвсе проверки пройдены" } else { Write-Host "`nпровалено: $fail"; exit 1 }
