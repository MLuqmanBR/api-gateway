"""Floating save bar that slides in from the bottom."""

from __future__ import annotations

from PyQt6.QtCore import QEasingCurve, QPropertyAnimation
from PyQt6.QtWidgets import QFrame, QGraphicsOpacityEffect, QHBoxLayout, QLabel, QPushButton, QWidget


from ..theme import THEME_BUS, palette


class FloatingBar(QFrame):
    """Bottom-center pill: 'Unsaved changes' + Discard + Save."""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("floatingbar")
        self.setFixedHeight(52)
        self.setVisible(False)


        layout = QHBoxLayout(self)
        layout.setContentsMargins(18, 8, 12, 8)
        layout.setSpacing(12)

        self.dot = QLabel()
        self.dot.setFixedSize(8, 8)
        layout.addWidget(self.dot)

        self.message = QLabel("Unsaved changes")
        layout.addWidget(self.message)
        layout.addStretch()

        self.discard_button = QPushButton("Discard")
        self.discard_button.setFlat(True)
        self.save_button = QPushButton("Save changes")
        self.save_button.setObjectName("primary")

        layout.addWidget(self.discard_button)
        layout.addWidget(self.save_button)
        # Fade in/out. A QWidget can carry only ONE graphics effect — the
        # opacity effect owns rendering, so no separate drop-shadow glow.
        self._opacity = QGraphicsOpacityEffect(self)
        self.setGraphicsEffect(self._opacity)
        self._anim = QPropertyAnimation(self._opacity, b"opacity", self)
        self._anim.setDuration(160)
        self._anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        # Connected ONCE here — connecting per hide() accumulated handlers
        # and re-ran them on every later animation tick.
        self._anim.finished.connect(self._on_anim_finished)

        self._apply_style()
        THEME_BUS.changed.connect(lambda _d: self._apply_style())

    def _apply_style(self) -> None:
        p = palette()
        self.setStyleSheet(
            f"#floatingbar {{"
            f"  background: {p['surface2']};"
            f"  border: 1px solid {p['overlay']};"
            f"  border-radius: 22px;"
            f"}}"
        )
        self.dot.setStyleSheet(f"background: {p['yellow']}; border-radius: 4px;")
        self.message.setStyleSheet(f"font-weight: 600; color: {p['text']};")


    def show_bar(self) -> None:
        if not self.isVisible():
            self.setVisible(True)
            self._anim.stop()
            self._anim.setStartValue(0.0)
            self._anim.setEndValue(1.0)
            self._anim.start()

    def hide_bar(self) -> None:
        if self.isVisible():
            self._anim.stop()
            self._anim.setStartValue(self._opacity.opacity())
            self._anim.setEndValue(0.0)
            self._anim.start()

    def _on_anim_finished(self) -> None:
        # Hide only after a fade-OUT completes; a fade-in ends at opacity 1.
        if self._anim.endValue() == 0.0:
            self.setVisible(False)
