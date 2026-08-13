"""systemd user-service controls used from the GUI.

Wraps :mod:`api_gateway_app.systemd` so pages have a small, mockable surface.
"""

from __future__ import annotations

from . import systemd as _sysd


class SystemdGuiError(RuntimeError):
    pass


def restart_service() -> None:
    try:
        _sysd.restart_service()
    except _sysd.SystemdError as exc:
        raise SystemdGuiError(str(exc)) from exc


def stop_service() -> None:
    try:
        _sysd.stop_service()
    except _sysd.SystemdError as exc:
        raise SystemdGuiError(str(exc)) from exc


def start_service() -> None:
    try:
        _sysd.ensure_service_installed()
        _sysd.start_service()
    except _sysd.SystemdError as exc:
        raise SystemdGuiError(str(exc)) from exc


def enable_service_at_boot(enabled: bool) -> None:
    from . import settings  # local import to avoid a cycle

    try:
        settings.service_enable_at_boot(enabled)
    except _sysd.SystemdError as exc:
        raise SystemdGuiError(str(exc)) from exc


SystemdError = SystemdGuiError
