"""Palette-aware widget styling helpers shared across pages."""

from __future__ import annotations

from PyQt6.QtWidgets import QLabel, QWidget

from ..theme import THEME_BUS, palette


def style_hero_title(label: QLabel) -> None:
    p = palette()
    label.setStyleSheet(f"font-size: 24px; font-weight: 800; letter-spacing: -0.3px; color: {p['text']};")


def style_page_subtitle(label: QLabel) -> None:
    p = palette()
    label.setStyleSheet(f"color: {p['subtext']}; font-size: 13px;")


def style_section_label(label: QLabel) -> None:
    p = palette()
    label.setStyleSheet(
        f"color: {p['muted']}; font-size: 11px; font-weight: 700; "
        f"letter-spacing: 0.8px; text-transform: uppercase;"
    )


def style_error(label: QLabel) -> None:
    p = palette()
    label.setStyleSheet(f"color: {p['red']};")


def watch_style(callback) -> None:
    """Wire a no-arg callable to fire on palette changes."""
    THEME_BUS.changed.connect(lambda _d: callback())
