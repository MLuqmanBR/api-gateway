"""Modern stat card: glass panel + icon + big value + delta."""

from __future__ import annotations

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import QFrame, QHBoxLayout, QLabel, QVBoxLayout

from ..icons import icon
from ..theme import THEME_BUS, hex_to_rgba, palette


class StatsCard(QFrame):
    def __init__(self, title: str, value: str = "—", subtext: str = "", icon_name: str = "dashboard", accent: str | None = None, parent=None):
        super().__init__(parent)
        self._icon_name = icon_name
        self._accent_key = accent or "blue"   # can be a palette key OR a hex string
        self.setObjectName("statscard")
        self.setMinimumHeight(96)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(14)

        self.accent_bar = QFrame()
        self.accent_bar.setFixedWidth(4)
        layout.addWidget(self.accent_bar)

        self.icon_label = QLabel()
        self.icon_label.setFixedSize(40, 40)
        self.icon_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.icon_label)

        text = QVBoxLayout()
        text.setSpacing(2)
        self.title_label = QLabel(title.upper())
        text.addWidget(self.title_label)
        self.value_label = QLabel(value)
        text.addWidget(self.value_label)
        self.sub_label = QLabel(subtext)
        self.sub_label.setVisible(bool(subtext))
        text.addWidget(self.sub_label)
        layout.addLayout(text, 1)

        # Apply the initial style from the current palette and re-apply on flip.
        self._apply_style()
        THEME_BUS.changed.connect(lambda _d: self._apply_style())

    # ------------------------------------------------------------------

    def _accent_hex(self) -> str:
        p = palette()
        k = self._accent_key
        if k.startswith("#"):
            return k
        return p.get(k, p["blue"])

    def _apply_style(self) -> None:
        p = palette()
        accent = self._accent_hex()
        self.setStyleSheet(
            f"#statscard {{"
            f"  background: {p['surface1']};"
            f"  border: 1px solid {p['surface2']};"
            f"  border-radius: 14px;"
            f"}}"
        )
        self.accent_bar.setStyleSheet(f"background: {accent}; border-radius: 2px;")
        self.icon_label.setPixmap(icon(self._icon_name, 22).pixmap(22, 22))
        self.icon_label.setStyleSheet(
            f"background: {hex_to_rgba(accent, 0.18)}; border-radius: 20px;")
        self.title_label.setStyleSheet(
            f"color: {p['subtext']}; font-size: 10.5px; font-weight: 700; letter-spacing: 0.8px;")
        self.value_label.setStyleSheet(
            f"font-size: 22px; font-weight: 800; color: {p['text']};")
        self.sub_label.setStyleSheet(f"color: {p['muted']}; font-size: 11.5px;")

    def set_value(self, value: str, subtext: str = "") -> None:
        self.value_label.setText(value)
        if subtext:
            self.sub_label.setText(subtext)
            self.sub_label.setVisible(True)
