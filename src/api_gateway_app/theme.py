"""Fluent Catppuccin theme — final pass.

Buttons are pills, inputs have richer focus rings, radii hit 12-14, surfaces
are layered, and we introduce `hover` and `tonal` pseudo-states everywhere.
"""

from __future__ import annotations

from typing import Dict

from PyQt6.QtCore import QObject, pyqtSignal


class _ThemeBus(QObject):
    changed = pyqtSignal(bool)


THEME_BUS = _ThemeBus()
_CURRENT_DARK = True

MOCHA: Dict[str, str] = {
    "crust":    "#11111b",
    "mantle":   "#181825",
    "base":     "#1e1e2e",
    "surface0": "#24273a",
    "surface1": "#313244",
    "surface2": "#45475a",
    "overlay":  "#585b70",
    "text":     "#cdd6f4",
    "subtext":  "#a6adc8",
    "muted":    "#7f849c",
    "blue":     "#89b4fa",
    "sapphire": "#74c7ec",
    "mauve":    "#cba6f7",
    "green":    "#a6e3a1",
    "yellow":   "#f9e2af",
    "peach":    "#fab387",
    "red":      "#f38ba8",
}

LATTE: Dict[str, str] = {
    "crust":    "#dce0e8",
    "mantle":   "#e6e9ef",
    "base":     "#eff1f5",
    "surface0": "#ffffff",
    "surface1": "#ccd0da",
    "surface2": "#bcc0cc",
    "overlay":  "#9ca0b0",
    "text":     "#4c4f69",
    "subtext":  "#6c6f85",
    "muted":    "#8c8fa1",
    "blue":     "#1e66f5",
    "sapphire": "#209fb5",
    "mauve":    "#8839ef",
    "green":    "#40a02b",
    "yellow":   "#df8e1d",
    "peach":    "#fe640b",
    "red":      "#d20f39",
}


def qss(p: Dict[str, str]) -> str:
    surface_pill = f"{p['surface1']}"
    return f"""
/* ---------- window shells ---------- */
QMainWindow, QDialog, QMenu, QToolTip {{
    background: {p['mantle']}; color: {p['text']};
}}
QWidget {{
    background: transparent; color: {p['text']};
    font-size: 13.5px;
}}
QWidget#pageRoot {{ background: {p['base']}; }}
QToolTip {{
    background: {p['surface1']}; border: 1px solid {p['surface2']};
    border-radius: 8px; padding: 6px 10px; color: {p['text']};
}}

/* ---------- chrome ---------- */
QWidget#topbar {{
    background: {p['mantle']};
    border-bottom: 1px solid {p['surface0']};
}}
QLabel#appTitle {{ font-size: 16px; font-weight: 750; }}
QLabel#pageCrumb {{ color: {p['muted']}; font-size: 13px; }}

/* ---------- sidebar ---------- */
QWidget#sidebar {{
    background: {p['mantle']};
    border-right: 1px solid {p['surface0']};
}}
QListWidget#nav {{
    background: transparent; border: none;
    padding: 6px 10px;
}}
QListWidget#nav::item {{
    padding: 10px 14px;
    margin: 2px 2px;
    border-radius: 9px;
    color: {p['subtext']};
    font-weight: 520;
}}
QListWidget#nav::item:hover {{
    background: {p['surface0']};
    color: {p['text']};
}}
QListWidget#nav::item:selected {{
    background: {p['surface1']};
    color: {p['text']};
    font-weight: 700;
    border-left: 3px solid {p['blue']};
}}

/* ---------- buttons ---------- */
QPushButton {{
    background: {p['surface1']};
    color: {p['text']};
    border: 1px solid {p['surface2']};
    border-radius: 9px;
    padding: 8px 16px;
    font-weight: 570;
}}
QPushButton:hover {{
    background: {p['surface2']};
    border-color: {p['overlay']};
}}
QPushButton:pressed {{
    background: {p['overlay']};
    color: {p['text']};
}}
QPushButton:disabled {{
    background: {p['surface0']};
    color: {p['muted']};
    border-color: {p['surface0']};
}}
QPushButton#primary {{
    background: {p['blue']};
    color: {p['crust']};
    border: none;
    font-weight: 750;
}}
QPushButton#primary:hover    {{ background: {p['sapphire']}; }}
QPushButton#primary:pressed  {{ background: {p['mauve']}; }}
QPushButton#danger {{
    background: transparent;
    color: {p['red']};
    border: 1px solid rgba(243,139,168,0.45);
}}
QPushButton#danger:hover  {{
    background: rgba(243,139,168,0.12);
    border-color: {p['red']};
}}
QPushButton#ghost {{ background: transparent; border: none; color: {p['subtext']}; }}
QPushButton#ghost:hover {{ background: {p['surface1']}; color: {p['text']}; }}

/* ---------- inputs ---------- */
QLineEdit, QPlainTextEdit, QTextEdit,
QSpinBox, QDoubleSpinBox, QComboBox {{
    background: {p['surface0']};
    color: {p['text']};
    border: 1.5px solid {p['surface2']};
    border-radius: 10px;
    padding: 9px 12px;
    selection-background-color: {p['blue']};
    selection-color: {p['crust']};
}}
QLineEdit:hover, QPlainTextEdit:hover, QTextEdit:hover,
QSpinBox:hover, QComboBox:hover {{
    border-color: {p['overlay']};
}}
QLineEdit:focus, QPlainTextEdit:focus, QTextEdit:focus,
QSpinBox:focus, QComboBox:focus {{
    border-color: {p['blue']};
}}
QLineEdit:disabled {{
    background: {p['mantle']}; color: {p['muted']}; border-color: {p['surface0']};
}}
QComboBox::drop-down {{ border: none; width: 26px; }}
QComboBox::down-arrow {{
    width: 0; height: 0;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-top: 6px solid {p['muted']};
    margin-right: 10px;
}}
QComboBox QAbstractItemView {{
    background: {p['surface1']}; color: {p['text']};
    border: 1px solid {p['surface2']};
    border-radius: 10px;
    padding: 4px;
    outline: none;
    selection-background-color: {p['blue']};
    selection-color: {p['crust']};
}}
QComboBox QAbstractItemView::item {{ padding: 7px 10px; border-radius: 6px; min-height: 24px; }}

/* ---------- cards & groups ---------- */
QFrame#card {{
    background: {p['surface0']};
    border: 1px solid {p['surface1']};
    border-radius: 14px;
}}
QGroupBox {{
    background: {p['base']};
    border: 1px solid {p['surface0']};
    border-radius: 14px;
    margin-top: 14px;
    padding: 14px 14px 12px 14px;
    font-weight: 650;
}}
QGroupBox::title {{
    subcontrol-origin: margin;
    left: 12px; top: 2px; padding: 0 6px;
    color: {p['subtext']};
    background: {p['base']};
}}

/* ---------- tables ---------- */
QTableView, QTableWidget, QListWidget, QTreeWidget {{
    background: {p['surface0']};
    alternate-background-color: {p['base']};
    border: 1px solid {p['surface1']};
    border-radius: 12px;
    gridline-color: transparent;
    outline: none;
}}
QTableView::item, QTableWidget::item, QListWidget::item, QTreeWidget::item {{
    padding: 9px 12px; border: none;
}}
QTableView::item:selected, QTableWidget::item:selected,
QListWidget::item:selected, QTreeWidget::item:selected {{
    background: {p['surface2']}; color: {p['text']};
}}
QTableView::item:hover, QListWidget::item:hover, QTreeWidget::item:hover {{
    background: {p['surface1']};
}}
QHeaderView::section {{
    background: {p['surface0']};
    color: {p['muted']};
    padding: 10px 14px;
    border: none;
    border-bottom: 1px solid {p['surface1']};
    font-size: 12px; font-weight: 720; letter-spacing: 0.5px;
}}

/* ---------- tabs ---------- */
QTabWidget::pane {{
    border: 1px solid {p['surface1']};
    border-radius: 12px;
    background: {p['base']};
    padding: 12px;
    top: -1px;
}}
QTabBar::tab {{
    background: transparent; color: {p['subtext']};
    padding: 8px 18px; margin: 4px 2px;
    border-radius: 9px; font-weight: 560;
}}
QTabBar::tab:hover {{ background: {p['surface0']}; color: {p['text']}; }}
QTabBar::tab:selected {{
    background: {p['surface0']}; color: {p['text']};
    font-weight: 720;
    border: 1px solid {p['surface1']};
}}

/* ---------- progress ---------- */
QProgressBar {{
    background: {p['surface1']};
    border: none; border-radius: 6px;
    height: 12px;
    text-align: center;
    color: {p['text']}; font-weight: 650; font-size: 10.5px;
}}
QProgressBar::chunk {{
    background: qlineargradient(x1:0, y1:0, x2:1, y2:0,
        stop:0 {p['sapphire']}, stop:1 {p['blue']});
    border-radius: 6px;
}}

/* ---------- checkboxes ---------- */
QCheckBox, QRadioButton {{ spacing: 8px; }}
QCheckBox::indicator, QRadioButton::indicator {{
    width: 18px; height: 18px;
    border: 1.5px solid {p['surface2']};
    background: {p['surface0']};
}}
QCheckBox::indicator {{ border-radius: 5px; }}
QRadioButton::indicator {{ border-radius: 9px; }}
QCheckBox::indicator:hover, QRadioButton::indicator:hover {{ border-color: {p['blue']}; }}
QCheckBox::indicator:checked, QRadioButton::indicator:checked {{
    background: {p['blue']}; border-color: {p['blue']};
}}

/* ---------- sliders ---------- */
QSlider::groove:horizontal {{ height: 6px; background: {p['surface1']}; border-radius: 3px; }}
QSlider::sub-page:horizontal {{ background: {p['blue']}; border-radius: 3px; }}
QSlider::handle:horizontal {{
    width: 18px; height: 18px; margin: -7px 0;
    border-radius: 9px; background: {p['text']};
    border: 2px solid {p['blue']};
}}
QSlider::handle:horizontal:hover {{ border-color: {p['sapphire']}; }}

/* ---------- scrollbars ---------- */
QScrollBar:vertical {{
    background: transparent; width: 10px;
    margin: 6px 4px 6px 4px; border: none;
}}
QScrollBar::handle:vertical {{
    background: {p['surface2']}; min-height: 36px; border-radius: 5px;
}}
QScrollBar::handle:vertical:hover {{ background: {p['overlay']}; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}

QScrollBar:horizontal {{
    background: transparent; height: 10px;
    margin: 4px 6px 6px 6px; border: none;
}}
QScrollBar::handle:horizontal {{
    background: {p['surface2']}; min-width: 36px; border-radius: 5px;
}}
QScrollBar::handle:horizontal:hover {{ background: {p['overlay']}; }}
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{ width: 0; }}
QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {{ background: transparent; }}

/* ---------- misc ---------- */
QMenu {{
    background: {p['surface1']};
    border: 1px solid {p['surface2']};
    border-radius: 10px;
    padding: 6px;
}}
QMenu::item {{ padding: 8px 24px 8px 16px; border-radius: 7px; }}
QMenu::item:selected {{ background: {p['blue']}; color: {p['crust']}; }}
QMenu::separator {{
    height: 1px; background: {p['surface2']}; margin: 6px 10px;
}}
QSplitter::handle {{ background: {p['surface1']}; }}
QSplitter::handle:vertical {{ height: 3px; }}
QSplitter::handle:horizontal {{ width: 3px; }}
QSplitter::handle:hover {{ background: {p['blue']}; }}
QStatusBar {{ background: {p['mantle']}; border-top: 1px solid {p['surface0']}; }}
"""


def current_palette(dark: bool = True) -> Dict[str, str]:
    """Return MOCHA or LATTE; widgets call this for mode-aware accent colors."""
    return MOCHA if dark else LATTE


def palette() -> Dict[str, str]:
    """Live palette — follows the currently-applied mode."""
    return MOCHA if _CURRENT_DARK else LATTE


def is_dark() -> bool:
    return _CURRENT_DARK


def hex_to_rgba(color: str, alpha: float) -> str:
    """Convert `#RRGGBB` + alpha → `rgba(r, g, b, a)` for use inside inline QSS."""
    color = color.lstrip("#")
    r, g, b = int(color[0:2], 16), int(color[2:4], 16), int(color[4:6], 16)
    return f"rgba({r}, {g}, {b}, {alpha})"


def apply(app, dark: bool = True) -> None:
    from PyQt6.QtGui import QFont

    global _CURRENT_DARK
    _CURRENT_DARK = dark
    app.setStyleSheet(qss(current_palette(dark)))
    app.setFont(QFont("Inter", 10))
    THEME_BUS.changed.emit(dark)
