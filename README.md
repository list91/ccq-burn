# ccq-burn — Claude Code quota speedometer for Windows

A tiny always-on-top strip on your Windows taskbar that shows **how fast you are burning your Claude Code limit** — measured against the 5-hour window — and **where you will land at reset**.

![strip](docs/strip.png)

```
5h [██████░░░░]  30%  ›24%/h›  132%   4:12  │  wk [████░░]  40%
    bar        used    rate    at reset  resets in   weekly limit
```

"40% used" means nothing on its own — was that one hour or four? The strip answers the only question that matters: **at this pace, will I make it to the reset?**

## Reading the strip

| Part | Meaning |
|---|---|
| `5h` bar | bright = used now, faded = forecast at reset |
| `30%` | used in the current 5-hour window (`~` = estimated between server readings) |
| `›24%/h›` | burn rate, percent of the limit per hour |
| `132%` | forecast at reset — **red** if over 100%, **blue** if you fit |
| `4:12` | time until the window resets |
| `wk 40%` | weekly limit |

Colors: used/weekly turn **yellow** at 75% and **red** at 90%. **Gray** means the data can't be trusted right now. When there is no fresh server reading the left label is replaced by a word — `СЛЕП` (blind), `СТАР` (stale), `ПАУЗ` (idle), `СТОП` (collector down) — instead of showing a made-up number.

> The strip's labels and tooltip are in Russian for now (`нед` = week). Numbers and colors are universal. PRs for i18n welcome.

## Requirements

- Windows 10 / 11
- [Node.js](https://nodejs.org) 18 or newer, installed system-wide (the official installer). fnm/Volta put node on per-user temporary shim paths the service can't use — the installer refuses them
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) logged in with a **Pro or Max** subscription (run `claude` once so `%USERPROFILE%\.claude\.credentials.json` exists)
- An account with **admin rights** (you'll get one UAC prompt: the installer creates a Windows service and a scheduled task)

## Install

Open **PowerShell** (normal, not admin) and run:

```powershell
git clone https://github.com/list91/ccq-burn.git
cd ccq-burn
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

No git? Download [the ZIP](https://github.com/list91/ccq-burn/archive/refs/heads/main.zip) and unpack it. Open the unpacked `ccq-burn-main` folder in Explorer, type `powershell` in the address bar, press Enter, and run the last line.

Accept the UAC prompt. If you decline it, nothing is installed. Within a minute the strip appears next to the tray. That's it — it starts with Windows from now on.

- **Move it:** drag with the mouse (position is remembered)
- **Menu:** right-click → `Перезапустить` (restart) / `Вернуть к трею` (back next to the tray) / `Выход (до конца сеанса)` (hide until next logon)
- **Restart everything:** `Ctrl+Alt+W`
- **Details:** hover the strip for a tooltip (forecast range, server age, next poll)

No internet access to nssm.cc? Download [NSSM 2.24](https://nssm.cc/download) yourself and run `.\install.ps1 -NssmPath C:\path\to\nssm.exe`.

## Update

In PowerShell, inside the folder you installed from (`ccq-burn`, or `ccq-burn-main` for the ZIP):

```powershell
git pull            # ZIP users: download and unpack the ZIP again instead
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Re-running the installer replaces the code and keeps your `config.json`. Do the same after upgrading or moving Node.js — the service remembers the exact `node.exe` path.

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Removes the service, the scheduled task, `C:\Tools\cc-widget`, the shortcuts and `%LOCALAPPDATA%\cc-widget`. Your Claude Code login is untouched.

## How it works

```
Claude Code logs (~/.claude/projects/*.jsonl) ─┐
                                               ├─► collector (Windows service, node) ─► data.json ─► strip (WPF)
Anthropic usage endpoint (every ~5 min) ───────┘                                         ▲
                                            watchdog (scheduled task, every 2 min) ──────┘ keeps both alive
```

- **Collector** (`collect.mjs`, service `CCWidgetCollector`): reads your local Claude Code logs every 5 s for the burn rate, and asks the same usage endpoint Claude Code's `/usage` uses for the real percentages. Between server readings it extrapolates and marks the number with `~`.
- **Strip** (`widget.ps1`): a borderless WPF window that redraws every 5 s.
- **Watchdog** (`watchdog.ps1`, task `CCWidgetWatchdog`): restarts whatever died, survives sleep, network loss and window resets.
- Network failures back off (1–5 min), server throttling backs off up to 30 min — it never hammers the endpoint.

Files live in `C:\Tools\cc-widget` (read-only for normal users, because the watchdog runs elevated; for the same reason `C:\Tools` itself is made admin-owned and can't be renamed or deleted) and `%LOCALAPPDATA%\cc-widget` (position, logs).

## Privacy

- Your OAuth token never leaves your machine except to Anthropic (`api.anthropic.com`, and `platform.claude.com` for token refresh), exactly like Claude Code itself.
- When the token expires the collector refreshes it and writes it back to `.credentials.json`, the same way Claude Code does.
- Nothing is sent anywhere else. No telemetry.

## Troubleshooting

| Symptom | Look at |
|---|---|
| strip missing | `%LOCALAPPDATA%\cc-widget\watchdog.log`, `widget_diag.log` |
| `СТОП` | service log `C:\Tools\cc-widget\svc.log`; `Get-Service CCWidgetCollector` |
| `СЛЕП` for long | tooltip shows the server error; `Ctrl+Alt+W` forces a fresh poll after a network outage |
| wrong numbers | make sure you are logged in to Claude Code with the account you use |
| `ПОЛОСКА-РАСХОДА-НЕ-РАБОТАЕТ.txt` on the desktop | the watchdog couldn't bring the strip back; the file says why. It is removed automatically once the strip works again |
| `Node.js ... is a temporary/shim path` | install Node.js from nodejs.org, then re-run the installer |

## Tests

```powershell
powershell -ExecutionPolicy Bypass -File tests\fmt_test.ps1   # slot widths
node tests\usage_regress.mjs                                  # poller / backoff logic
```

## Disclaimer

Unofficial, not affiliated with Anthropic. It relies on an undocumented endpoint that may change.

## License

MIT
