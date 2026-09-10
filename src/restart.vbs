Set sh = CreateObject("Wscript.Shell")
' Same hardening as widget.vbs: a full path to powershell.exe and System32 as the
' current directory, because the search order puts the current directory first.
sh.CurrentDirectory = "C:\Windows\System32"
sh.Run """C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""C:\Tools\cc-widget\restart.ps1""", 0, False
