"""systemd --user lifecycle management for the api-gateway backend.

The desktop app never spawns the Node server directly; it only talks to
systemd --user. This module owns the unit file install, status, and control.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

UNIT_NAME = "api-gateway.service"
TEMPLATE_REL = Path("resources/systemd/api-gateway.service")


class SystemdError(RuntimeError):
    def __init__(self, message: str, returncode: int | None = None):
        super().__init__(message)
        self.returncode = returncode


def _repo_root() -> Path:
    """Absolute path to the repository root.

    ``APIGW_REPO_ROOT`` overrides everything (set by install.sh and honoured
    when the app is installed/frozen).  Otherwise we infer it from this file:
    ``src/api_gateway_app/systemd.py`` -> parents[2] is the repo root.
    """
    env = os.environ.get("APIGW_REPO_ROOT")
    if env:
        return Path(env).resolve()
    return Path(__file__).resolve().parents[2]


def repo_root() -> Path:
    return _repo_root()


def _run(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=30,
        )
    except FileNotFoundError as exc:
        raise SystemdError(f"systemctl not found: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise SystemdError(f"systemctl timed out: {args}") from exc
    if check and result.returncode != 0:
        raise SystemdError(
            f"{' '.join(args)} failed ({result.returncode}): "
            f"{result.stderr.strip() or result.stdout.strip()}",
            returncode=result.returncode,
        )
    return result


def _user_unit_path() -> Path:
    return Path.home() / ".config" / "systemd" / "user" / UNIT_NAME


def ensure_service_installed() -> Path:
    """Install the user unit with the repo path baked in. Returns the path."""
    target = _user_unit_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    template = _repo_root() / TEMPLATE_REL
    if not template.exists():
        raise SystemdError(f"unit template missing: {template}")
    text = template.read_text(encoding="utf-8")
    text = text.replace("__REPO_ROOT__", str(_repo_root()))
    target.write_text(text, encoding="utf-8")
    _run(["systemctl", "--user", "daemon-reload"])
    return target


def service_installed() -> bool:
    return _user_unit_path().exists()


def is_service_running() -> bool:
    result = _run(
        ["systemctl", "--user", "is-active", "--quiet", UNIT_NAME.removesuffix(".service")],
        check=False,
    )
    return result.returncode == 0


def ensure_service_running() -> None:
    if not is_service_running():
        start_service()


def start_service() -> None:
    _run(["systemctl", "--user", "start", UNIT_NAME.removesuffix(".service")])


def stop_service() -> None:
    _run(["systemctl", "--user", "stop", UNIT_NAME.removesuffix(".service")], check=False)


def restart_service() -> None:
    _run(["systemctl", "--user", "restart", UNIT_NAME.removesuffix(".service")])


@dataclass
class ServiceStatus:
    active: bool
    pid: int | None
    memory_bytes: int | None
    uptime_s: float | None


def service_status() -> ServiceStatus:
    result = _run(
        [
            "systemctl", "--user", "show", UNIT_NAME.removesuffix(".service"),
            "-p", "ActiveState,MainPID,MemoryCurrent,ActiveEnterTimestampUSec",
        ],
        check=False,
    )
    if result.returncode != 0:
        return ServiceStatus(active=False, pid=None, memory_bytes=None, uptime_s=None)
    props: dict[str, str] = {}
    for line in result.stdout.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            props[key.strip()] = value.strip()

    active = props.get("ActiveState") == "active"
    pid = _int_or_none(props.get("MainPID"))
    pid = pid if pid and pid > 0 else None
    memory = _int_or_none(props.get("MemoryCurrent"))
    entered_usec = _int_or_none(props.get("ActiveEnterTimestampUSec"))
    uptime: float | None = None
    if active and entered_usec and entered_usec > 0:
        import time

        uptime = max(0.0, time.time() - (entered_usec / 1_000_000))
    return ServiceStatus(active=active, pid=pid, memory_bytes=memory, uptime_s=uptime)


def _int_or_none(value: str | None) -> int | None:
    if not value or not value.isdigit():
        return None
    return int(value)


def unit_installed(target: Path | None = None) -> bool:
    target = target or _user_unit_path()
    return target.exists() and "__REPO_ROOT__" not in target.read_text(encoding="utf-8")
