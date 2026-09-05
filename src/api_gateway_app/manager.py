"""Backend lifecycle manager: systemd user unit OR the `api` CLI.

The app used to assume the backend is always a systemd user service.  On
this machine (and any machine where the operator manages the gateway with
the global ``api`` command) that assumption is wrong twice over:

1. It hides the real state — ``systemctl --user`` says "inactive" while the
   CLI-managed server happily serves :3001.
2. Starting the unit while a CLI-managed server already holds the port
   spawns a *duplicate* server that crash-loops with EADDRINUSE
   (Restart=on-failure).

The manager is mode-aware: every lifecycle decision goes through
``status()`` first, and ``ensure_running()`` NEVER starts anything when the
server already answers ``/api/ping`` — that invariant is the duplicate-
server guard.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from . import systemd as _sysd

UNIT = _sysd.UNIT_NAME
PING_TIMEOUT_S = 2.0
START_TIMEOUT_S = 30.0


class BackendMode(str, Enum):
    SYSTEMD = "systemd"  # user unit active
    CLI = "cli"           # server up, api CLI on PATH (this machine)
    NONE = "none"         # server down


@dataclass
class BackendStatus:
    running: bool
    mode: BackendMode
    pid: int | None = None          # None in CLI mode
    memory_bytes: int | None = None
    uptime_s: float | None = None


def _run(args: list[str], timeout: float = 15.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, capture_output=True, text=True, timeout=timeout, check=False
    )


def ping_ok() -> bool:
    """True when the backend answers GET /api/ping on localhost."""
    try:
        import httpx

        response = httpx.get(
            "http://127.0.0.1:3001/api/ping", timeout=PING_TIMEOUT_S
        )
        return response.status_code == 200
    except Exception:  # noqa: BLE001 — any failure means "not up"
        return False


def api_cli_path() -> str | None:
    """Path of the global ``api`` CLI, or None when not installed."""
    return shutil.which("api")


def status() -> BackendStatus:
    """Current backend state. Cheap; safe to poll every few seconds."""
    if _sysd.is_service_running():
        st = _sysd.service_status()
        return BackendStatus(
            running=True, mode=BackendMode.SYSTEMD, pid=st.pid,
            memory_bytes=st.memory_bytes, uptime_s=st.uptime_s,
        )
    if ping_ok():
        st = _cli_process_status()
        return BackendStatus(
            running=True, mode=BackendMode.CLI,
            pid=st[0], memory_bytes=st[1], uptime_s=st[2],
        )
    return BackendStatus(running=False, mode=BackendMode.NONE)


def _cli_process_status() -> tuple[int | None, int | None, float | None]:
    """Identify the CLI-managed backend process via the api CLI's own
    instance registry (``<repo>/.api-gateway.instances``: {port: pid}) and
    read its live stats from /proc — the systemd path gets this from
    systemctl, the CLI path would otherwise show "—" cards forever."""
    candidates: list[int] = []
    # The CLI writes its instance registry next to the checkout it manages.
    # With a linked worktree (app running from api-gateway-dev) the backend
    # lives in the main checkout — search every sibling checkout sharing
    # the same base name (api-gateway, api-gateway-dev, ...) too.
    root = _sysd.repo_root()
    parent = root.parent
    base_name = root.name.removesuffix("-dev")
    search_dirs = [root] + sorted(
        p for p in parent.glob(f"{base_name}*") if p.is_dir()
    )
    for registry in (d / ".api-gateway.instances" for d in search_dirs):
        try:
            port_map = json.loads(registry.read_text())
            candidates.extend(
                int(pid) for pid in port_map.values() if str(pid).isdigit()
            )
        except (OSError, ValueError, AttributeError):
            continue
    for pid in candidates:
        try:
            cmdline = (Path("/proc") / str(pid) / "cmdline").read_bytes()
        except OSError:
            continue
        parts = cmdline.decode("utf-8", "replace").split("\0")
        if any(p.endswith("server/dist/index.js") for p in parts if p):
            return _proc_stats(pid)
    return (None, None, None)


def _proc_stats(pid: int) -> tuple[int | None, int | None, float | None]:
    """RSS bytes + process start time → (pid, memory_bytes, uptime_s)."""
    try:
        statm = (Path("/proc") / str(pid) / "statm").read_text().split()
        rss_pages = int(statm[1])
        stat = (Path("/proc") / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
        starttime_ticks = int(stat[19])
        with open("/proc/uptime", encoding="ascii") as up:
            system_uptime = float(up.read().split()[0])
    except (OSError, ValueError, IndexError):
        return (None, None, None)
    memory_bytes = rss_pages * os.sysconf("SC_PAGE_SIZE")
    hz = os.sysconf("SC_CLK_TCK")
    uptime_s = max(0.0, system_uptime - starttime_ticks / hz)
    return (pid, memory_bytes, uptime_s)


def ensure_running() -> bool:
    """Make sure exactly one backend server is running.

    INVARIANT (duplicate-server guard): when the server already answers
    /api/ping, return True immediately and start NOTHING.  The unit is
    deliberately left alone on machines that manage the gateway with the
    api CLI (it stays disabled per the operator's standing rule).
    """
    if ping_ok():
        return True

    cli = api_cli_path()
    if cli:
        try:
            _run([cli, "start"], timeout=120.0)
        except (subprocess.TimeoutExpired, OSError):
            return False
        return _wait_for_ping(START_TIMEOUT_S)

    if _sysd.service_installed():
        try:
            _sysd.start_service()
        except _sysd.SystemdError:
            return False
        return _wait_for_ping(START_TIMEOUT_S)

    return False


def _wait_for_ping(seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if ping_ok():
            return True
        time.sleep(0.25)
    return False


def stop() -> None:
    """Stop the backend, however it is being run."""
    st = status()
    if st.mode == BackendMode.SYSTEMD:
        _sysd.stop_service()
    elif st.mode == BackendMode.CLI:
        cli = api_cli_path()
        if cli:
            try:
                _run([cli, "stop"], timeout=60.0)
            except (subprocess.TimeoutExpired, OSError):
                pass


def restart() -> None:
    """Restart the backend, however it is being run."""
    st = status()
    if st.mode == BackendMode.SYSTEMD:
        _sysd.restart_service()
    elif st.mode == BackendMode.CLI:
        cli = api_cli_path()
        if cli:
            try:
                _run([cli, "restart"], timeout=120.0)
            except (subprocess.TimeoutExpired, OSError):
                pass
    else:
        ensure_running()


def label(status_obj: BackendStatus | None = None) -> str:
    """Human label for the current mode, for the titlebar pill."""
    st = status_obj or status()
    if not st.running:
        return "stopped"
    if st.mode == BackendMode.CLI:
        return "api CLI · running"
    return "Service · running"
