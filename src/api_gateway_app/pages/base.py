"""Base class shared by all native pages.

Provides:
- shared ``api: ApiClient``
- a thread-pool ``call_in_background`` helper that marshals results back to
  the GUI thread via a queued Qt signal (never block the GUI on network)
- standardized loading / error handling
- ``refresh()`` and ``on_show()`` lifecycle hooks
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from PyQt6.QtCore import Qt, pyqtSignal, pyqtSlot
from PyQt6.QtWidgets import QLabel, QWidget

from ..backend import ApiClient

_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="api-gw")


class _Done:
    __slots__ = ("value", "error", "on_success", "on_error", "token")

    def __init__(self, value, error, on_success, on_error, token):
        self.value = value
        self.error = error
        self.on_success = on_success
        self.on_error = on_error
        self.token = token


class BasePage(QWidget):
    title = ""

    _job_done = pyqtSignal(object)

    def __init__(self, api: ApiClient, parent: QWidget | None = None):
        super().__init__(parent)
        self.api = api
        self._refresh_token = 0
        self._job_done.connect(
            self._dispatch, type=Qt.ConnectionType.QueuedConnection
        )

        self.error_label = QLabel("")
        self.error_label.setWordWrap(True)
        self.error_label.setVisible(False)

        self.loading_label = QLabel("Loading…")
        self.loading_label.setVisible(False)

        self._apply_theme_style()
        from ..theme import THEME_BUS
        THEME_BUS.changed.connect(lambda _d: self._apply_theme_style())

    def _apply_theme_style(self) -> None:
        from ..theme import palette as _get_palette
        p = _get_palette()
        self.error_label.setStyleSheet(f"color: {p['red']}; padding: 4px 0;")
        self.loading_label.setStyleSheet(f"color: {p['subtext']}; padding: 4px 0;")

    # -- lifecycle hooks (override in subclasses) ---------------------------

    def refresh(self) -> None:
        """Fetch data and rebuild widgets. Overridden by each page."""

    def on_show(self) -> None:
        self.refresh()

    def on_hide(self) -> None:
        """Stop timers/polling when the user navigates away."""

    # -- async plumbing ------------------------------------------------------

    def call_in_background(
        self,
        fn: Callable[[], Any],
        on_success: Callable[[Any], None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
    ) -> None:
        """Run ``fn`` on a worker thread; callbacks fire on the GUI thread.

        A monotonically increasing token is captured per call so a page that
        refreshes twice quickly can drop the stale result.
        """
        self._refresh_token += 1
        token = self._refresh_token

        def runner() -> None:
            try:
                value = fn()
                done = _Done(value, None, on_success, on_error, token)
            except Exception as exc:  # noqa: BLE001 - forwarded to GUI
                done = _Done(None, exc, on_success, on_error, token)
            self._job_done.emit(done)

        _executor.submit(runner)

    def is_current(self, token: int) -> bool:
        return token == self._refresh_token

    @pyqtSlot(object)
    def _dispatch(self, done: _Done) -> None:
        if done.error is None:
            if done.on_success is not None and self.is_current(done.token):
                done.on_success(done.value)
        else:
            if not self.is_current(done.token):
                return
            if done.on_error is not None:
                done.on_error(done.error)
            else:
                self.show_error(done.error)

    # -- standard feedback ---------------------------------------------------

    def set_loading(self, loading: bool) -> None:
        self.loading_label.setVisible(loading)

    def show_error(self, error: Exception) -> None:
        self.error_label.setText(str(error))
        self.error_label.setVisible(True)

    def clear_error(self) -> None:
        self.error_label.clear()
        self.error_label.setVisible(False)
