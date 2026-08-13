#!/usr/bin/env bash
# Distro-agnostic installer for the api-gateway native Linux app.
#
# Linux package landscape handled:
#   - Debian/Ubuntu/PikaOS      : apt        (python3-pyqt6, python3-httpx)
#   - Fedora/Bluefin/Aurora      : dnf        (python3-qt6, python3-httpx)
#   - Arch/CachyOS               : pacman     (python-pyqt6, python-httpx)
#   - openSUSE                   : zypper
#   - Nix / anything else        : pipx or pip --user fallback (no sudo needed)
#
# The script is idempotent: safe to re-run to upgrade or repair.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export APIGW_REPO_ROOT="$REPO_ROOT"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==> WARNING:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m==> ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- Detect distro ----------------------------------------------------

detect_distro() {
  local id="" like=""
  if [ -f /etc/os-release ]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    id="${ID:-}"
    like="${ID_LIKE:-}"
  fi
  # Prefer exact IDs we recognize (apt/dnf/pacman mainline)
  case "$id" in
    debian|ubuntu|fedora|arch|opensuse*|alpine|void|gentoo|nixos|pikaos|pop|linuxmint|elementary|bazzite|bluefin|aurora|nobara|manjaro|cachyos|endeavouros|garuda)
      echo "$id"; return ;;
  esac
  # Otherwise fall through to ID_LIKE so derivatives (PikaOS->debian,
  # Bluefin->fedora, CachyOS->arch, ...) hit the right package manager.
  for like_entry in $like; do
    case "$like_entry" in
      debian|ubuntu|fedora|arch|opensuse|alpine|void|gentoo)
        echo "$like_entry"; return ;;
    esac
  done
  echo "${id:-linux}"
}

install_python_deps() {
  local distro="$1"
  say "Installing Python deps for '$distro'"

  case "$distro" in
    debian|ubuntu|pikaos|pika|linuxmint|pop|elementary|kali|mint)
      sudo apt-get update -qq
      sudo apt-get install -y python3-pyqt6 python3-httpx python3-httpx-sse
      ;;
    fedora|bazzite|bluefin|aurora|nobara)
      sudo dnf install -y python3-qt6 python3-httpx
      ;;
    arch|manjaro|cachyos|endeavouros|garuda)
      sudo pacman -S --needed --noconfirm python-pyqt6 python-httpx
      ;;
    opensuse*|suse)
      sudo zypper install -y python3-qt6 python3-httpx
      ;;
    alpine)
      sudo apk add py3-pyqt6 py3-httpx
      ;;
    void)
      sudo xbps-install -Sy python3-pyqt6 python3-httpx
      ;;
    gentoo)
      sudo emerge --ask=n dev-python/PyQt6 dev-python/httpx
      ;;
    nixos)
      warn "NixOS detected — installing via pipx (flake/distro packages not managed by this script)"
      install_via_pipx || install_via_pip_user
      return
      ;;
    *)
      warn "Unknown distro '$distro' — falling back to pipx / pip --user"
      install_via_pipx || install_via_pip_user
      return
      ;;
  esac
}

install_via_pipx() {
  command -v pipx >/dev/null 2>&1 || return 1
  say "Installing app with pipx"
  pipx install --force "$REPO_ROOT"
}
install_via_pip_user() {
  say "Installing app with pip --user"
  command -v python3 >/dev/null 2>&1 || die "python3 not found"
  python3 -m pip install --user --upgrade "$REPO_ROOT" || die "pip install failed"
}

need_cmd() { command -v "$1" >/dev/null 2>&1; }

# ---------- 1) Python deps -----------------------------------------------------

DISTRO="$(detect_distro)"
echo "==> Distribution family: $DISTRO"
install_python_deps "$DISTRO"

# ---------- 2) Locate the entry point -----------------------------------------

if need_cmd api-gateway; then
  BIN="$(command -v api-gateway)"
elif [ -x "$HOME/.local/bin/api-gateway" ]; then
  BIN="$HOME/.local/bin/api-gateway"
else
  # No pip on this system — symlink the repo source in. The apt/dnf/pacman
  # packages already provided PyQt6 + httpx, so a plain PYTHONPATH install
  # is enough.
  ENTRY_DIR="$HOME/.local/bin"
  mkdir -p "$ENTRY_DIR"
  cat > "$ENTRY_DIR/api-gateway" <<EOF
#!/usr/bin/env bash
exec /usr/bin/env PYTHONPATH="$REPO_ROOT/src" python3 -m api_gateway_app "\$@"
EOF
  chmod +x "$ENTRY_DIR/api-gateway"
  BIN="$ENTRY_DIR/api-gateway"
  say "Registered repo source as $BIN (no pip available on this system)"
fi
echo "==> Entry point: $BIN"

# ---------- 3) Icon + .desktop -------------------------------------------------

say "Installing icon + launcher entry"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$ICON_DIR" "$APPS_DIR"

cp "$REPO_ROOT/resources/icons/api-gateway.svg" "$ICON_DIR/api-gateway.svg"

# Rewrite Exec= to the resolved binary so the entry works even before PATH
# picks up ~/.local/bin for a fresh install.
sed "s|^Exec=.*|Exec=$BIN|" "$REPO_ROOT/resources/desktop/api-gateway.desktop" \
  > "$APPS_DIR/api-gateway.desktop"

if need_cmd update-desktop-database; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi
if need_cmd gtk-update-icon-cache; then
  gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
fi

# ---------- 4) systemd user unit ----------------------------------------------

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
sed "s|__REPO_ROOT__|$REPO_ROOT|g" \
  "$REPO_ROOT/resources/systemd/api-gateway.service" > "$UNIT_DIR/api-gateway.service"

systemctl --user daemon-reload
systemctl --user enable --now api-gateway.service

# ---------- 5) Sanity ----------------------------------------------------------

sleep 1
if curl -sf --max-time 3 http://127.0.0.1:3001/api/ping >/dev/null 2>&1; then
  say "Backend is listening on http://127.0.0.1:3001"
else
  warn "Backend not answering on :3001 — check 'systemctl --user status api-gateway'"
fi

cat <<EOF

Done.
  Launch:   $BIN             (or from your app launcher: "API Gateway")
  Service:  systemctl --user status api-gateway
  Web UI:   http://localhost:3001 (unchanged, still works)
EOF
