# API Gateway — native Linux desktop app

A PyQt6/Qt-Widgets client that turns the api-gateway web dashboard into a
proper Linux desktop application: native window, system tray, autostart,
logind-managed backend service.

The Node/Express server and the React dashboard stay exactly as they were —
this is an **additional** front end, not a replacement. Both can drive the
same local gateway at the same time.

## Features

- **Native Qt Widgets UI** — no browser engine, no Electron. Idle CPU is
  essentially zero; RSS in the tens of MiB, not hundreds.
- **9 pages:** Dashboard, Analytics, Keys, Budget, Playground, Fallback,
  Embeddings, Privacy, Settings. Coverage mirrors the web dashboard's core
  workflows (key management, routing, budgets, privacy); some web-only
  niceties (e.g. live analytics charts) are simpler here.
- **System tray:** closing the window minimizes to the tray; the backend
  keeps serving `/v1` traffic. Right-click the icon for full control.
- **Autostart:** logind-managed (`systemctl --user enable api-gateway`) so
  the gateway comes up with your session. The GUI autostart is a separate
  toggle in Settings.
- **Live events** via Server-Sent Events, threaded off the GUI.
- **Catppuccin theming** matching the web dashboard.

## Install

The installer is distro-aware and detects your package manager.
```bash
git clone https://github.com/MLuqmanBR/api-gateway.git api-gateway
cd api-gateway
./scripts/install.sh
```

That's it. The script:

1. Installs the Python dependencies using your distro's native packages
   (`apt / dnf / pacman / zypper / apk / xbps / emerge` — detected from
   `/etc/os-release`).
2. If there's no native package path (e.g. NixOS or truly bare distro),
   falls back to `pipx` and then `pip --user`.
3. Installs a `~/.local/share/icons/hicolor/scalable/apps/api-gateway.svg`
   icon and `~/.local/share/applications/api-gateway.desktop` launcher.
4. Installs `~/.config/systemd/user/api-gateway.service` (with the repo
   path baked in) and starts it.

After install, open "API Gateway" from your launcher or run:

```bash
api-gateway
```

### Manual dependencies (if the script can't auto-install)

You need three Python packages (plus one optional):

| Distro | Command |
|---|---|
| Debian / Ubuntu / PikaOS / Mint / Pop | `sudo apt install python3-pyqt6 python3-httpx` |
| Fedora / Nobara / Bazzite / Aurora | `sudo dnf install python3-qt6 python3-httpx` |
| Arch / CachyOS / EndeavourOS | `sudo pacman -S python-pyqt6 python-httpx` |
| openSUSE Tumbleweed | `sudo zypper install python3-qt6 python3-httpx` |
| Alpine | `sudo apk add py3-pyqt6 py3-httpx` |
| Void | `sudo xbps-install -S python3-pyqt6 python3-httpx` |
| Gentoo | `sudo emerge --ask=n dev-python/PyQt6 dev-python/httpx` |
| NixOS | `pipx install .` (or `nix profile install` your own) |

Optional: `PyQt6-Charts` enables the native analytics charts; without it the
Analytics page falls back to a simpler text summary.

Then `./scripts/install.sh` again — the package-detection step is idempotent.

### What about pip / pipx?

The installer tries `apt`/`dnf`/`pacman` first so it works on systems that
deliberately remove pip (Debian family strips the `ensurepip` module on
purpose). It only falls back to `pipx`/`pip --user` when there's no known
native package.

### Verify

- `systemctl --user status api-gateway` — service should be `active (running)`
- `curl http://127.0.0.1:3001/api/ping` — should return `{"status":"ok"}`
- `api-gateway` from a terminal — the window should open with the dashboard

## Usage

- **Close the window** — minimizes to the system tray. The backend keeps
  proxying `/v1` requests.
- **Quit from the tray menu** — actually exits the GUI process. The backend
  service keeps running.
- **Settings → Application preferences** — toggle "Start at login" (GUI
  autostart) and "Start backend at boot" (service autostart) independently.

## Architecture

```
+---------------+          HTTP/JSON + SSE           +---------------------+
| api-gateway   |<---------------------------------->| api-gateway.service |
| PyQt6 GUI     |    http://127.0.0.1:3001/api/*     | systemctl --user    |
+---------------+                                    +---------------------+
        |                                                       |
        |      the web dashboard is                             |
+---->  http://localhost:3001  <-----  react client ------------+
```

The app *controls* the service; it does not embed it. The Node server is the
same `server/dist/index.js` you've been running — now just managed by
systemd.

## Files it touches

- `~/.local/bin/api-gateway` (if installed via pip/pipx)
- `~/.local/share/applications/api-gateway.desktop`
- `~/.local/share/icons/hicolor/scalable/apps/api-gateway.svg`
- `~/.config/systemd/user/api-gateway.service`
- `~/.config/autostart/api-gateway.desktop` (only when toggled on in Settings)
- The repo checkout — nothing is deleted or modified.

## Uninstall

```bash
./scripts/uninstall.sh
```

Removes the package, the desktop entry, the icon, and the systemd unit.
The Node server and the web dashboard are untouched.

## Why Qt instead of Electron?

Lower idle resources, better native integration, and no per-app bundled
Chromium. On this machine: the app idles at ~30–50 MiB RSS; a comparable
Electron shell would idle at 200–400 MiB. Closing the window really does
close it; there's no renderer process lingering.