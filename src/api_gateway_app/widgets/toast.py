"""Modern stacked toast notifications in the bottom-right corner."""

from __future__ import annotations

import weakref

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtWidgets import QFrame, QHBoxLayout, QLabel, QWidget

from ..icons import icon
from ..theme import hex_to_rgba, palette


def _kind_style(kind: str) -> dict:
    p = palette()
    table = {
        "info":    {"accent": p["blue"],   "icon": "dashboard"},
        "success": {"accent": p["green"],  "icon": "check"},
        "error":   {"accent": p["red"],    "icon": "error"},
        "warning": {"accent": p["yellow"], "icon": "alert"},
    }
    return table.get(kind, table["info"])


class Toast(QFrame):
    def __init__(self, message: str, kind: str = "info", parent: QWidget | None = None):
        super().__init__(parent or _overlay_parent())
        self.kind = kind
        style = _kind_style(kind)
        accent = style["accent"]
        p = palette()

        self.setObjectName("toast")
        self.setStyleSheet(
            f"#toast {{"
            f"  background: {hex_to_rgba(p['surface2'], 0.98)};"
            f"  border: 1px solid {p['overlay']};"
            f"  border-left: 4px solid {accent};"
            f"  border-radius: 10px;"
            f"}}"
        )
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 10, 14, 10)
        layout.setSpacing(10)

        icon_label = QLabel()
        icon_label.setPixmap(icon(style["icon"], size=18).pixmap(18, 18))
        icon_label.setFixedSize(22, 22)
        layout.addWidget(icon_label)

        text = QLabel(message)
        text.setWordWrap(True)
        text.setStyleSheet(f"color: {p['text']};")
        layout.addWidget(text, 1)

        self.destroyed.connect(self._on_destroyed)
        self.adjustSize()
        self._position_in_stack()
        self.show()
        self.raise_()
        QTimer.singleShot(4200, self.deleteLater)

    def _on_destroyed(self, *_args):
        Toaster._unregister(self)

    def _position_in_stack(self):
        parent = self.parentWidget()
        if parent is None:
            return
        parent_geo = parent.geometry()
        Toaster._register(self)
        offset = 0
        for live_toast, h in Toaster._iter():
            if live_toast is self:
                continue
            offset += h + 8
        x = parent_geo.right() - self.width() - 22
        y = parent_geo.bottom() - self.height() - 22 - offset
        self.move(x, y)


class Toaster:
    """Stack manager for toasts (weakref-based so deleted toasts don't crash)."""

    _STACK: list = []  # list[tuple[weakref.ref[Toast], int]]

    @classmethod
    def show(cls, message: str, kind: str = "info") -> None:
        Toast(message, kind)

    @classmethod
    def success(cls, message: str) -> None:
        cls.show(message, "success")

    @classmethod
    def error(cls, message: str) -> None:
        cls.show(message, "error")

    @classmethod
    def info(cls, message: str) -> None:
        cls.show(message, "info")

    # -- internals -----------------------------------------------------

    @classmethod
    def _register(cls, toast: "Toast") -> None:
        cls._STACK.append((weakref.ref(toast), toast.height()))
        cls._STACK = [entry for entry in cls._STACK if entry[0]() is not None]

    @classmethod
    def _unregister(cls, toast: "Toast") -> None:
        cls._STACK = [
            entry for entry in cls._STACK
            if entry[0]() is not None and entry[0]() is not toast
        ]

    @classmethod
    def _iter(cls):
        """Yield live (Toast, height) pairs; prune dead refs as we go."""
        live = []
        for ref, h in cls._STACK:
            obj = ref()
            if obj is not None:
                live.append((obj, h))
        cls._STACK = [(weakref.ref(t), h) for t, h in live]
        return live


def _overlay_parent() -> QWidget | None:
    from PyQt6.QtWidgets import QApplication

    return QApplication.activeWindow()
