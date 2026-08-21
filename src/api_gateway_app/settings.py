"""App preferences + autostart integration.

QSettings-backed flags plus the XDG/systemd hooks that make the app a
first-class Linux citizen (autostart entry, systemd unit enable).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from PyQt6.QtCore import QSettings

from .systemd import UNIT_NAME, ensure_service_installed, repo_root

ORG = "ApiGateway"
APP = "API Gateway"

AUTOSTART_DIR = Path.home() / ".config" / "autostart"
AUTOSTART_FILE = AUTOSTART_DIR / "api-gateway.desktop"


def settings() -> QSettings:
    return QSettings(ORG, APP)


def get_bool(key: str, default: bool) -> bool:
    value = settings().value(key, default)
    if isinstance(value, bool):
        return value
    return str(value).lower() in {"1", "true", "yes", "on"}


def set_bool(key: str, value: bool) -> None:
    settings().setValue(key, bool(value))


def set_theme(dark: bool) -> None:
    settings().setValue("theme/dark", bool(dark))


def theme_dark() -> bool:
    return get_bool("theme/dark", True)


def start_minimized() -> bool:
    return get_bool("app/start_minimized", False)


def set_start_minimized(value: bool) -> None:
    set_bool("app/start_minimized", value)


# SECURITY (audit L95): the dashboard session token is stored in PLAINTEXT in
# the QSettings backend (~/.config/ApiGateway/API Gateway.conf). It grants
# full dashboard access, so protection here is only as good as the file's
# permissions (assume 0600 home dir). Future work: move to libsecret/KWallet
# via a keyring backend once a dependency-free path exists across all distros
# this installer supports (apt/dnf/pacman have no common keyring Python dep).
def dashboard_token() -> str | None:
    """Persisted dashboard session token (`x-dashboard-token` / bearer)."""
    value = settings().value("auth/dashboard_token")
    return str(value) if value else None


def set_dashboard_token(token: str | None) -> None:
    """Persist (or clear) the dashboard session token across launches."""
    if token:
        settings().setValue("auth/dashboard_token", token)
    else:
        settings().remove("auth/dashboard_token")


def notify_on_error() -> bool:
    return get_bool("app/notify_on_error", True)


def set_notify_on_error(value: bool) -> None:
    set_bool("app/notify_on_error", value)


# ---------------------------------------------------------------------------
# Autostart
# ---------------------------------------------------------------------------

def _desktop_exec_line() -> str:
    exe = shutil.which("api-gateway")
    if not exe:
        # install.sh registers ~/.local/bin/api-gateway even on the no-pip
        # path (a bash wrapper exporting PYTHONPATH=<repo>/src). A login
        # shell's PATH may not include ~/.local/bin inside the autostart
        # environment, so probe that location directly.
        local = Path.home() / ".local" / "bin" / "api-gateway"
        if local.is_file() and os.access(local, os.X_OK):
            exe = str(local)
    if exe:
        return f"{exe} --minimized"
    # Repo-checkout fallback: make the module importable explicitly instead
    # of relying on PYTHONPATH/CWD luck — a no-pip install never puts
    # api_gateway_app on sys.path (audit L96).
    src = repo_root() / "src"
    return f'/usr/bin/env PYTHONPATH="{src}" python3 -m api_gateway_app --minimized'


def set_autostart(enabled: bool) -> None:
    """Install or remove the XDG autostart entry.

    The systemd *service* handles the backend boot; this desktop entry only
    starts the GUI (in the tray) at login.  The service itself is enabled
    separately via ``systemctl --user enable``.
    """
    if enabled:
        AUTOSTART_DIR.mkdir(parents=True, exist_ok=True)
        AUTOSTART_FILE.write_text(
            "[Desktop Entry]\n"
            "Type=Application\n"
            "Version=1.0\n"
            "Name=API Gateway\n"
            "Comment=Start the API Gateway client in the system tray\n"
            f"Exec={_desktop_exec_line()}\n"
            "Icon=api-gateway\n"
            "Terminal=false\n"
            "X-GNOME-Autostart-enabled=true\n"
            "StartupNotify=false\n",
            encoding="utf-8",
        )
    else:
        try:
            AUTOSTART_FILE.unlink()
        except FileNotFoundError:
            pass


def autostart_enabled() -> bool:
    return AUTOSTART_FILE.exists()


# ---------------------------------------------------------------------------
# systemd enable (the service, independent of the GUI autostart entry)
# ---------------------------------------------------------------------------

def service_enable_at_boot(enabled: bool) -> None:
    ensure_service_installed()
    verb = "enable" if enabled else "disable"
    subprocess.run(
        ["systemctl", "--user", verb, UNIT_NAME.removesuffix(".service")],
        check=False, capture_output=True, text=True,
    )


def service_boot_enabled() -> bool:
    result = subprocess.run(
        ["systemctl", "--user", "is-enabled", UNIT_NAME.removesuffix(".service")],
        check=False, capture_output=True, text=True,
    )
    return result.returncode == 0 and result.stdout.strip() == "enabled"
