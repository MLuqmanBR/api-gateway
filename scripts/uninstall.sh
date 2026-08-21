#!/usr/bin/env bash
# Remove the api-gateway native Linux app integration.
#
# Removes: desktop entry, icon, systemd user unit, Python package.
# Never removes: the Node server, the web dashboard, or this repo.
set -euo pipefail

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

say "Disabling + stopping systemd user unit"
systemctl --user disable --now api-gateway.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/api-gateway.service"
systemctl --user daemon-reload || true

say "Removing desktop entry and icon"
rm -f "$HOME/.local/share/applications/api-gateway.desktop"
rm -f "$HOME/.local/share/icons/hicolor/scalable/apps/api-gateway.svg"
rm -f "$HOME/.config/autostart/api-gateway.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
fi

say "Removing Python package"
if command -v pipx >/dev/null 2>&1; then
  pipx uninstall api-gateway-app 2>/dev/null || true
fi
# A `pip install --user` puts the package in ~/.local/lib/python3.X/site-packages,
# where pipx never looks — uninstall it too and sweep any leftovers.
if command -v python3 >/dev/null 2>&1; then
  if python3 -m pip show api-gateway-app 2>/dev/null | grep -q 'Location: .*\.local/lib/python3\..*/site-packages'; then
    say "Removing pip --user installation"
    python3 -m pip uninstall -y api-gateway-app >/dev/null 2>&1 || true
  fi
fi
rm -rf "$HOME"/.local/lib/python3.*/site-packages/api_gateway_app* 2>/dev/null || true
# pip --user installs leave an entry point in ~/.local/bin
rm -f "$HOME/.local/bin/api-gateway" 2>/dev/null || true

say "Web dashboard and Node server were not touched — they're still on this repo."
echo "Done."
