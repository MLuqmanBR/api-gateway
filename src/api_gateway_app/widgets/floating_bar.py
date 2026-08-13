"""Floating save bar that slides in from the bottom."""

from __future__ import annotations

from PyQt6.QtCore import QEasingCurve, QPropertyAnimation, Qt
from PyQt6.QtWidgets import QFrame, QGraphicsOpacityEffect, QHBoxLayout, QLabel, QPushButton, QWidget


from ..theme import THEME_BUS, palette


class FloatingBar(QFrame):
    """Bottom-center pill: 'Unsaved changes' + Discard + Save."""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("floatingbar")
        self.setFixedHeight(52)
        self.setVisible(False)

        # Backdrop glow
        shadow = self.graphicsEffect_drop_shadow()
        self.setGraphicsEffect(shadow)

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

        # Simple fade-in animation
        self._opacity = QGraphicsOpacityEffect(self)
        self.setGraphicsEffect(self._opacity)
        self._anim = QPropertyAnimation(self._opacity, b"opacity", self)
        self._anim.setDuration(160)
        self._anim.setEasingCurve(QEasingCurve.Type.OutCubic)

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

    @staticmethod
    def graphicsEffect_drop_shadow():
        from PyQt6.QtWidgets import QGraphicsDropShadowEffect
        from PyQt6.QtGui import QColor

        e = QGraphicsDropShadowEffect()
        e.setBlurRadius(28)
        e.setColor(QColor(0, 0, 0, 120))
        e.setOffset(0, 4)
        return e

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
            # hide at end
            def _hide():
                if abs(self._opacity.opacity() - 1.0) < 0.01:
                    pass
                else:
                    self.setVisible(False)
            self._anim.finished.connect(_hide)
