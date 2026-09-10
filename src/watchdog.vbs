Set sh = CreateObject("Wscript.Shell")
' CurrentDirectory and the full path to powershell.exe are deliberate: the search
' order puts the current directory ahead of System32, and this task runs
' elevated: nothing user-writable may be searched first.
sh.CurrentDirectory = "C:\Windows\System32"
' Wait for the watchdog to finish. With a non-blocking call wscript.exe exits at
' once, so the scheduler thinks the task is over: ExecutionTimeLimit never
' applies and IgnoreNew never suppresses an overlapping run.
sh.Run """C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Tools\cc-widget\watchdog.ps1""", 0, True
