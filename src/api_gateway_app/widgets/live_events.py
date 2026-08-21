"""Live events wall — its own styling that groups events by severity."""

from __future__ import annotations

from datetime import datetime

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QHBoxLayout, QLabel, QListWidget, QListWidgetItem, QVBoxLayout, QWidget

from ..icons import icon
from ..theme import THEME_BUS, palette

# H28: these are the event types the SERVER actually publishes
# (services/events.ts): request.start/done/error/aborted, routing.*,
# health.check.*, interceptor.* — the previous map keyed on types that
# never occur, so every entry fell through to the gray default.
_KINDS = {
    "request.start":   ("#89b4fa", "→", "Request"),
    "request.done":    ("#a6e3a1", "✓", "Done"),
    "request.error":   ("#f38ba8", "✕", "Failed"),
    "request.aborted": ("#fab387", "⊘", "Aborted"),
    "routing.*":       ("#89b4fa", "↔", "Routing"),
    "health.check.*":  ("#cba6f7", "♥", "Health"),
    "interceptor.*":   ("#f38ba8", "●", "Privacy"),
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


def _summarize(event: dict) -> str:
    """Readable one-liner from the REAL event payload: the server sends
    `type` plus contextual fields (platform/modelId/reason/error/…) — not
    `message`/`detail`."""
    kind = str(event.get("type", ""))
    bits: list[str] = []
    for key in ("platform", "modelId", "model", "reason", "error", "provider"):
        v = event.get(key)
        if isinstance(v, (str, int, float)) and str(v):
            bits.append(str(v))
            if len(bits) >= 2:
                break
    return kind + ("  ·  " + "  ".join(bits) if bits else "")


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
        # H28: the server stamps events with `at` (epoch ms).
        ts = event.get("at") or event.get("ts") or event.get("timestamp")
        stamp = ""
        if isinstance(ts, (int, float)):
            stamp = datetime.fromtimestamp(ts / 1000 if ts > 1e12 else ts).strftime("%H:%M:%S")
        message = _summarize(event)
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
