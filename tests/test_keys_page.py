"""Keys page tests: populate regression + payload shapes + action routes.

The keys page used to crash on EVERY refresh (a `delete` button referenced
before creation — NameError at populate time) and blank the Enabled
column right after filling it.  These tests lock the fixed populate path
and the dialog payload contracts.
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtWidgets import QApplication, QMessageBox, QPushButton  # noqa: E402

from api_gateway_app.pages.keys import (  # noqa: E402
    KeysPage,
    PlatformSettingsDialog,
    RegisterModelDialog,
)

_APP: QApplication | None = None


def _app() -> QApplication:
    global _APP
    if _APP is None:
        _APP = QApplication.instance() or QApplication([])
    return _APP


class _FakeApi:
    """Records every method call; returns canned data."""

    def __init__(self):
        self.calls: list[tuple] = []

    def __getattr__(self, name):
        def _call(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return {}
        return _call


def _key_rows() -> list[dict]:
    return [
        {"id": 1, "platform": "p1", "maskedKey": "****abc", "label": "l1",
         "status": "valid", "enabled": 1},
        {"id": 2, "platform": "p2", "maskedKey": "****def", "label": "",
         "status": "invalid", "enabled": 0},
    ]


def _inline_bg(page):
    """Patch page.call_in_background to run `fn` synchronously."""
    captured: dict = {}

    def _run(fn, on_success=None, on_error=None):
        try:
            captured["result"] = fn()
        except Exception as exc:  # noqa: BLE001
            if on_error:
                on_error(exc)
            captured["error"] = exc

    return mock.patch.object(page, "call_in_background", side_effect=_run), captured


class PopulateTests(unittest.TestCase):
    def setUp(self):
        _app()
        self.page = KeysPage(_FakeApi())

    def test_populate_keys_does_not_crash(self):
        """Regression: _populate_keys raised NameError (`delete`)."""
        try:
            self.page._populate_keys(_key_rows())
        except Exception as exc:  # pragma: no cover — regression guard
            self.fail(f"_populate_keys raised {exc!r}")

    def test_enabled_column_is_filled(self):
        """Regression: the stray setItem(i,5,'') blanked Enabled after fill."""
        self.page._populate_keys(_key_rows())
        self.assertEqual(self.page.keys_table.item(0, 5).text(), "yes")
        self.assertEqual(self.page.keys_table.item(1, 5).text(), "no")

    def test_actions_cell_has_delete_and_check(self):
        self.page._populate_keys(_key_rows())
        cell = self.page.keys_table.cellWidget(0, 6)
        texts = [b.text() for b in cell.findChildren(QPushButton)]
        self.assertIn("Delete", texts)
        self.assertIn("Check", texts)


class PlatformSettingsDialogTests(unittest.TestCase):
    def test_payload_only_changed_fields(self):
        """Untouched limits must NOT be sent (a null would wipe them — N55)."""
        _app()
        settings = {
            "platform": "p1",
            "rpmLimit": 60,
            "rpdLimit": None,
            "tpmLimit": 1000,
            "tpdLimit": None,
            "stickySessionsEnabled": False,
        }
        dlg = PlatformSettingsDialog(settings)
        dlg.rpm.setCurrentText("60")       # unchanged → not sent
        dlg.rpd.setCurrentText("1000")    # None → 1000 → sent
        dlg.tpm.setCurrentText("")         # 1000 → None → sent
        dlg.tpd.setCurrentText("")          # None → None → not sent
        dlg.sticky.setChecked(True)         # → sent
        self.assertEqual(
            dlg.payload(),
            {"rpdLimit": 1000, "tpmLimit": None, "stickySessionsEnabled": True},
        )

    def test_payload_empty_when_nothing_changed(self):
        _app()
        settings = {"rpmLimit": 60, "stickySessionsEnabled": True}
        dlg = PlatformSettingsDialog(settings)
        dlg.sticky.setChecked(True)
        self.assertEqual(dlg.payload(), {})


class RegisterModelDialogTests(unittest.TestCase):
    def test_payload_shape(self):
        _app()
        dlg = RegisterModelDialog()
        dlg.model_id.setText("my-model")
        dlg.display_name.setText("My Model")
        self.assertEqual(
            dlg.payload(),
            {"modelId": "my-model", "displayName": "My Model", "contextWindow": 128000},
        )

    def test_bad_context_window_omitted(self):
        _app()
        dlg = RegisterModelDialog()
        dlg.model_id.setText("m")
        dlg.display_name.setText("M")
        dlg.context_window.setText("")
        self.assertEqual(dlg.payload(), {"modelId": "m", "displayName": "M"})


class ClientKeyActionTests(unittest.TestCase):
    def test_toggle_issues_patch_with_enabled_false(self):
        _app()
        page = KeysPage(_FakeApi())
        with _inline_bg(page)[0]:
            page._toggle_client_key("ck-123", False, mock.Mock())
        self.assertEqual(
            page.api.calls,
            [("patch", ("/api/keys/client/ck-123",), {"json": {"enabled": False}})],
        )

    def test_delete_uses_client_key_route(self):
        _app()
        page = KeysPage(_FakeApi())
        with _inline_bg(page)[0], \
             mock.patch.object(QMessageBox, "question",
                               return_value=QMessageBox.StandardButton.Yes):
            page._delete_client_key("ck-123")
        self.assertEqual(
            page.api.calls,
            [("delete", ("/api/keys/client/ck-123",), {})],
        )


if __name__ == "__main__":
    unittest.main()
