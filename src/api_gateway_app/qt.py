"""Compatibility shim — `Qt` re-exported for the quirky base-page signal typing.

Not strictly needed by imports elsewhere, kept so `theme.py`'s module-level
``QPushButton_accent`` reference stays valid and future paint code has a home.
"""

from PyQt6.QtCore import Qt  # noqa: F401
