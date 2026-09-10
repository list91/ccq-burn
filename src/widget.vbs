Set sh = CreateObject("Wscript.Shell")
' CurrentDirectory and the full path to powershell.exe are deliberate: the search
' order puts the current directory ahead of System32, and the watchdog task
' that starts this runs elevated.
sh.CurrentDirectory = "C:\Windows\System32"
sh.Run """C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Tools\cc-widget\widget.ps1""", 0, False
