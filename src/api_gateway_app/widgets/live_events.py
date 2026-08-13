"""Live events wall — its own styling that groups events by severity."""

from __future__ import annotations

from datetime import datetime

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QListWidget, QListWidgetItem, QVBoxLayout, QWidget

from ..icons import icon
from ..theme import THEME_BUS, palette

_KINDS = {
    "routing.*":           ("#89b4fa", "↔", "Routing"),
    "auth.*":              ("#cba6f7", "●", "Auth"),
    "provider.*":          ("#f9e2af", "●", "Provider"),
    "interceptor.*":       ("#f38ba8", "●", "Privacy"),
    "request.failed":      ("#f38ba8", "✕", "Failed"),
    "request.succeeded":   ("#a6e3a1", "✓", "OK"),
}
_MAX = 240


def _style_for(event: dict):
    kind = str(event.get("type", ""))
    for pattern, meta in _KINDS.items():
        if pattern.endswith("*") and kind.startswith(pattern[:-1]):
            return meta
        if kind == pattern:
            return meta
    return "#a6adc8", "•", "Event"


class LiveEvents(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)

        title_row = QHBoxLayout()
        self.title = QLabel("LIVE ACTIVITY")
        clear_btn = QLabel()
        clear_btn.setAlignment(Qt.AlignmentFlag.AlignRight)
        clear_btn.linkActivated.connect(lambda _l: self.clear())
        title_row.addWidget(self.title)
        title_row.addStretch()
        title_row.addWidget(clear_btn)
        layout.addLayout(title_row)
        self._clear_link = clear_btn

        self.list = QListWidget()
        self.list.setObjectName("events")
        self.list.setFrameShape(QListWidget.Shape.NoFrame)
        self.list.setAlternatingRowColors(False)
        self.list.setWordWrap(True)
        layout.addWidget(self.list, 1)

        self._apply_style()
        THEME_BUS.changed.connect(lambda _d: self._apply_style())

    def _apply_style(self) -> None:
        p = palette()
        self.title.setStyleSheet(f"color: {p['muted']}; font-size: 11px; font-weight: 800; letter-spacing: 1px;")
        self._clear_link.setText(f"<a href='clear' style='color: {p['blue']};'>clear</a>")
        self.list.setStyleSheet(
            f"QListWidget#events {{ background: {p['crust']}; border-radius: 10px; padding: 6px; }}"
            f"QListWidget#events::item {{ padding: 6px 8px; border-radius: 6px; }}"
        )

    def add_event(self, event: dict) -> None:
        color, dot, source = _style_for(event)
        ts = event.get("ts") or event.get("timestamp") or event.get("time")
        stamp = ""
        if isinstance(ts, (int, float)):
            stamp = datetime.fromtimestamp(ts / 1000 if ts > 1e12 else ts).strftime("%H:%M:%S")
        message = event.get("message") or event.get("detail") or event.get("type", "")
        summary = f"{stamp}  {dot} {source}  {message}"
        item = QListWidgetItem(summary)
        item.setForeground(self._qcolor(color))
        item.setIcon(icon("server", 14))
        self.list.insertItem(0, item)
        while self.list.count() > _MAX:
            self.list.takeItem(self.list.count() - 1)

    @staticmethod
    def _qcolor(hex_str: str):
        from PyQt6.QtGui import QColor
        return QColor(hex_str)

    def clear(self) -> None:
        self.list.clear()
