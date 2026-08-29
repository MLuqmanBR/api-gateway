"""GUI-side helpers around backend lifecycle (systemd unit OR api CLI).

Wraps :mod:`api_gateway_app.manager` so pages have a small, mockable surface,
and owns the ONE shared service-status poller (titlebar pill + dashboard both
read its result) plus a ``run_in_background`` helper so subprocess/HTTP
probes never block the GUI thread.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from PyQt6.QtCore import QObject, Qt, QTimer, pyqtSignal, pyqtSlot

from . import manager as _mgr
from . import systemd as _sysd

_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="api-gw-sysd")


class SystemdGuiError(RuntimeError):
    pass


def restart_service() -> None:
    """Restart the backend however it is running (api CLI or the unit)."""
    _mgr.restart()


def stop_service() -> None:
    """Stop the backend however it is running."""
    _mgr.stop()


def start_service() -> None:
    """Start the backend; a no-op when it already answers /api/ping."""
    if not _mgr.ensure_running():
        raise SystemdGuiError(
            "Could not start the backend — run 'api start' in a terminal."
        )


def enable_service_at_boot(enabled: bool) -> None:
    from . import settings  # local import to avoid a cycle

    try:
        settings.service_enable_at_boot(enabled)
    except _sysd.SystemdError as exc:
        raise SystemdGuiError(str(exc)) from exc


SystemdError = SystemdGuiError


# ------------------------------------------------------------------ polling


class ServiceStatusPoller(QObject):
    """Single shared poller for the backend (api CLI or systemd unit).

    ``manager.status()`` runs on a worker thread (a hung probe must never
    freeze the window); the result is marshalled back to the GUI thread
    via a queued signal.  Probes never overlap: a tick while one is in
    flight is skipped.
    """

    status_ready = pyqtSignal(object)  # manager.BackendStatus

    def __init__(self, interval_ms: int = 5000):
        super().__init__()
        self._timer = QTimer(self)
        self._timer.setInterval(interval_ms)
        self._timer.timeout.connect(self.refresh)
        self._in_flight = False

    def start(self) -> None:
        """Poll once now, then on the timer interval."""
        self.refresh()
        self._timer.start()

    def refresh(self) -> None:
        """Kick off one status probe now (no-op while another is in flight)."""
        if self._in_flight:
            return
        self._in_flight = True
        _executor.submit(self._probe)

    def _probe(self) -> None:
        try:
            status = _mgr.status()
        except Exception:  # noqa: BLE001 — treat any probe failure as down
            status = _mgr.BackendStatus(running=False, mode=_mgr.BackendMode.NONE)
        # Queued connection: subscribers run on the GUI thread.
        self.status_ready.emit(status)
        self._in_flight = False



_poller: ServiceStatusPoller | None = None


def service_status_poller() -> ServiceStatusPoller:
    """Process-wide shared poller — titlebar pill and dashboard consume it."""
    global _poller
    if _poller is None:
        _poller = ServiceStatusPoller()
    return _poller


# -------------------------------------------------------------- one-shot jobs


class _JobRelay(QObject):
    done = pyqtSignal(object)


_relay = _JobRelay()


@pyqtSlot(object)
def _dispatch(job: tuple) -> None:
    value, error, on_success, on_error = job
    if error is None:
        if on_success is not None:
            on_success(value)
    elif on_error is not None:
        on_error(error)


_relay.done.connect(_dispatch, type=Qt.ConnectionType.QueuedConnection)


def run_in_background(
    fn: Callable[[], Any],
    on_success: Callable[[Any], None] | None = None,
    on_error: Callable[[Exception], None] | None = None,
) -> None:
    """Run ``fn`` on a worker thread; callbacks fire on the GUI thread.

    Same pattern as ``BasePage.call_in_background``, for service controls
    that live outside pages (titlebar pill, tray menu).
    """

    def runner() -> None:
        try:
            job = (fn(), None, on_success, on_error)
        except Exception as exc:  # noqa: BLE001 - forwarded to the GUI thread
            job = (None, exc, on_success, on_error)
        _relay.done.emit(job)

    _executor.submit(runner)
