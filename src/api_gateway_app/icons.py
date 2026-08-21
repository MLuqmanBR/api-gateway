"""QPainter-based vector icons. No PyQt6.QtSvg dependency.

Every icon is drawn with QPainter primitives — circles, lines, rects —
so it works on a stock system PyQt6 build (which lacks QSvgRenderer on
some distro splits).
"""

from __future__ import annotations

from functools import lru_cache

from PyQt6.QtCore import QPointF, QRectF, Qt
from PyQt6.QtGui import QColor, QIcon, QPainter, QPainterPath, QPen, QPixmap

# Catppuccin accent hexes
BLUE = "#89b4fa"
GREEN = "#a6e3a1"
RED = "#f38ba8"
YELLOW = "#f9e2af"
PEACH = "#fab387"
MAUVE = "#cba6f7"
TEXT = "#cdd6f4"
SUBTEXT = "#a6adc8"


def _c(hex_str: str) -> QColor:
    return QColor(hex_str)


def _new_painter(pixmap: QPixmap) -> QPainter:
    p = QPainter(pixmap)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
    return p


def _pen(color: str, width: float = 2.0) -> QPen:
    pen = QPen(_c(color))
    pen.setWidthF(width)
    pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
    return pen


# ---------------------------------------------------------------------------
# Individual renderers.  Each takes (painter, w, h) and paints a 24x24 design
# scaled to w×h.  They're simple enough to fit in a few statements; the goal
# is recognizability at small sizes, not illustration.
# ---------------------------------------------------------------------------

def _i_dashboard(p: QPainter, w, h):
    s = w / 24.0
    p.setPen(_pen(BLUE, 2.5 * s))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawRoundedRect(QRectF(3 * s, 3 * s, 18 * s, 18 * s), 4 * s, 4 * s)
    p.setBrush(_c(BLUE))
    p.setPen(Qt.PenStyle.NoPen)
    p.drawEllipse(QPointF(12 * s, 12 * s), 4.5 * s, 4.5 * s)


def _i_analytics(p: QPainter, w, h):
    s = w / 24.0
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setPen(Qt.PenStyle.NoPen)
    for x, top, color in ((5, 12, BLUE), (12, 4, MAUVE), (19, 9, YELLOW)):
        p.setBrush(_c(color))
        p.drawRoundedRect(QRectF(x * s, top * s, 4 * s, (20 - top) * s), 2 * s, 2 * s)


def _i_keys(p: QPainter, w, h):
    s = w / 24.0
    p.setPen(_pen(YELLOW, 2.5 * s))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawEllipse(QPointF(8 * s, 12 * s), 3.8 * s, 3.8 * s)
    p.drawLine(QPointF(12 * s, 12 * s), QPointF(20 * s, 12 * s))
    p.drawLine(QPointF(17 * s, 12 * s), QPointF(17 * s, 15 * s))
    p.drawLine(QPointF(20 * s, 12 * s), QPointF(20 * s, 14 * s))


def _i_budget(p: QPainter, w, h):
    s = w / 24.0
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(_c(GREEN))
    p.drawEllipse(QPointF(12 * s, 12 * s), 9.5 * s, 9.5 * s)
    p.setBrush(_c("#1e1e2e"))
    p.drawEllipse(QPointF(12 * s, 12 * s), 6.8 * s, 6.8 * s)
    p.setPen(_pen(GREEN, 2 * s))
    p.setBrush(_c("#1e1e2e"))
    p.drawEllipse(QPointF(12 * s, 12 * s), 5.5 * s, 5.5 * s)


def _i_playground(p: QPainter, w, h):
    s = w / 24.0
    path = QPainterPath(QPointF(7 * s, 4.5 * s))
    path.lineTo(QPointF(19 * s, 12 * s))
    path.lineTo(QPointF(7 * s, 19.5 * s))
    path.closeSubpath()
    p.setPen(_pen(BLUE, 2 * s))
    p.setBrush(_c(BLUE))
    p.drawPath(path)


def _i_fallback(p: QPainter, w, h):
    s = w / 24.0
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(_c(BLUE))
    p.drawEllipse(QPointF(12 * s, 5 * s), 3 * s, 3 * s)
    p.setBrush(_c(GREEN))
    p.drawEllipse(QPointF(6 * s, 19 * s), 3 * s, 3 * s)
    p.setBrush(_c(YELLOW))
    p.drawEllipse(QPointF(18 * s, 19 * s), 3 * s, 3 * s)
    p.setPen(_pen(BLUE, 2 * s))
    p.drawLine(QPointF(12 * s, 8 * s), QPointF(6 * s, 16.5 * s))
    p.drawLine(QPointF(12 * s, 8 * s), QPointF(18 * s, 16.5 * s))


def _i_embeddings(p: QPainter, w, h):
    s = w / 24.0
    p.setPen(_pen(MAUVE, 2 * s))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawEllipse(QPointF(12 * s, 5.5 * s), 3 * s, 3 * s)   # top
    p.drawEllipse(QPointF(5 * s, 18 * s), 3 * s, 3 * s)    # bottom-left
    p.drawEllipse(QPointF(19 * s, 18 * s), 3 * s, 3 * s)   # bottom-right
    p.drawLine(QPointF(12 * s, 8.5 * s), QPointF(5 * s, 15 * s))
    p.drawLine(QPointF(12 * s, 8.5 * s), QPointF(19 * s, 15 * s))
    p.drawLine(QPointF(8.5 * s, 18 * s), QPointF(15.5 * s, 18 * s))


def _i_privacy(p: QPainter, w, h):
    s = w / 24.0
    path = QPainterPath()
    path.moveTo(QPointF(12 * s, 3 * s))
    path.lineTo(QPointF(5.5 * s, 6 * s))
    path.lineTo(QPointF(5.5 * s, 11.5 * s))
    path.cubicTo(QPointF(5.5 * s, 17.5 * s), QPointF(8.5 * s, 20.5 * s), QPointF(12 * s, 22.5 * s))
    path.cubicTo(QPointF(15.5 * s, 20.5 * s), QPointF(18.5 * s, 17.5 * s), QPointF(18.5 * s, 11.5 * s))
    path.lineTo(QPointF(18.5 * s, 6 * s))
    path.closeSubpath()
    p.setPen(_pen(GREEN, 2 * s))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawPath(path)
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(_c(RED))
    p.drawEllipse(QPointF(12 * s, 10.5 * s), 2.2 * s, 2.2 * s)


def _i_settings(p: QPainter, w, h):
    s = w / 24.0
    p.setPen(_pen(SUBTEXT, 2 * s))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawEllipse(QPointF(12 * s, 12 * s), 3.2 * s, 3.2 * s)
    for dx, dy in ((0, -7), (0, 7), (-7, 0), (7, 0), (-5, -5), (5, -5), (-5, 5), (5, 5)):
        x1, y1 = 12 + dx * 0.85, 12 + dy * 0.85
        x2, y2 = 12 + dx, 12 + dy
        p.drawLine(QPointF(x1 * s, y1 * s), QPointF(x2 * s, y2 * s))


def _i_check(p: QPainter, w, h):
    s = w / 24.0
    p.setPen(_pen(GREEN, 3 * s))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawPolyline([QPointF(4.5 * s, 12.5 * s), QPointF(9.5 * s, 17.5 * s), QPointF(19.5 * s, 5.5 * s)])


def _i_error(p: QPainter, w, h):
    s = w / 24.0
    p.setPen(_pen(RED, 2.5 * s))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawEllipse(QPointF(12 * s, 12 * s), 8.5 * s, 8.5 * s)
    p.drawLine(QPointF(9 * s, 9 * s), QPointF(15 * s, 15 * s))
    p.drawLine(QPointF(15 * s, 9 * s), QPointF(9 * s, 15 * s))


def _i_alert(p: QPainter, w, h):
    s = w / 24.0
    path = QPainterPath()
    path.moveTo(QPointF(12 * s, 4 * s))
    path.lineTo(QPointF(22 * s, 20.5 * s))
    path.lineTo(QPointF(2 * s, 20.5 * s))
    path.closeSubpath()
    p.setPen(_pen(YELLOW, 2 * s))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawPath(path)
    p.drawLine(QPointF(12 * s, 10 * s), QPointF(12 * s, 15.5 * s))
    p.drawPoint(QPointF(12 * s, 18.5 * s))


def _i_server(p: QPainter, w, h):
    s = w / 24.0
    p.setPen(_pen(BLUE, 2 * s))
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.drawRoundedRect(QRectF(3 * s, 5 * s, 18 * s, 6 * s), 2 * s, 2 * s)
    p.drawRoundedRect(QRectF(3 * s, 13 * s, 18 * s, 6 * s), 2 * s, 2 * s)
    p.setPen(Qt.PenStyle.NoPen)
    p.setBrush(_c(GREEN))
    p.drawEllipse(QPointF(7 * s, 8 * s), 1.1 * s, 1.1 * s)
    p.setBrush(_c(RED))
    p.drawEllipse(QPointF(7 * s, 16 * s), 1.1 * s, 1.1 * s)


_RENDERERS = {
    "dashboard":  _i_dashboard,
    "analytics":  _i_analytics,
    "keys":       _i_keys,
    "budget":     _i_budget,
    "playground": _i_playground,
    "fallback":   _i_fallback,
    "embeddings": _i_embeddings,
    "privacy":    _i_privacy,
    "settings":   _i_settings,
    "check":      _i_check,
    "error":      _i_error,
    "alert":      _i_alert,
    "server":     _i_server,
}


@lru_cache(maxsize=None)
def icon_pixmap(name: str, size: int = 20) -> QPixmap:
    fn = _RENDERERS.get(name, _i_dashboard)
    pixmap = QPixmap(size, size)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = _new_painter(pixmap)
    fn(painter, size, size)
    painter.end()
    return pixmap


def icon(name: str, size: int = 20) -> QIcon:
    qicon = QIcon()
    for mul in (1, 2, 3):
        qicon.addPixmap(icon_pixmap(name, size * mul))
    return qicon


__all__ = ["icon", "icon_pixmap",
           "BLUE", "GREEN", "RED", "YELLOW", "PEACH", "MAUVE", "TEXT", "SUBTEXT"]
