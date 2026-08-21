"""Compatibility shim — bare `Qt` namespace re-exported from PyQt6.QtCore.

Not imported anywhere in the app package itself; `tests/test_pages_import.py`
lists it to keep the module importable. Kept as a stable home for a plain
`Qt` import and any future shared Qt-level helpers.
"""

from PyQt6.QtCore import Qt  # noqa: F401
