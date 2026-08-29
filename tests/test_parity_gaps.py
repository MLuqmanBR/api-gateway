"""Parity-gap tests: webhooks CRUD routes, platform master switch,
token-budget bar, inventory labels, key label rename.
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtWidgets import QApplication, QMessageBox  # noqa: E402

from api_gateway_app.pages.fallback import _fmt_tokens, TokenBudgetBar  # noqa: E402

_APP: QApplication | None = None


def _app() -> QApplication:
    global _APP
    if _APP is None:
        _APP = QApplication.instance() or QApplication([])
    return _APP


class _FakeApi:
    def __init__(self):
        self.calls: list[tuple] = []

    def __getattr__(self, name):
        def _call(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return {}
        return _call


def _inline_bg(page):
    def _run(fn, on_success=None, on_error=None):
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            if on_error:
                on_error(exc)

    return mock.patch.object(page, "call_in_background", side_effect=_run)


class WebhooksRouteTests(unittest.TestCase):
    def _page(self):
        from api_gateway_app.pages.webhooks import WebhooksPage
        return WebhooksPage(_FakeApi())

    def test_create_posts_url_secret_filter(self):
        _app()
        page = self._page()
        page.url_edit.setText("https://example.com/hook")
        page.secret_edit.setText("s3cret")
        page.filter_edit.setText("request.*")
        with _inline_bg(page):
            page._add()
        posts = [c for c in page.api.calls if c[0] == "post" and c[1][0] == "/api/webhooks"]
        self.assertEqual(len(posts), 1)
        self.assertEqual(
            posts[0][2]["json"],
            {"url": "https://example.com/hook", "secret": "s3cret",
             "events_filter": "request.*"},
        )

    def test_create_requires_url_and_secret(self):
        _app()
        page = self._page()
        page.url_edit.setText("")
        with _inline_bg(page):
            page._add()
        self.assertEqual(page.api.calls, [])

    def test_toggle_patches_id_query_param(self):
        _app()
        page = self._page()
        with _inline_bg(page):
            page._toggle(7, True)
        patches = [c for c in page.api.calls if c[0] == "patch"]
        self.assertEqual(patches[0][1][0], "/api/webhooks")
        self.assertEqual(patches[0][2]["params"], {"id": 7})
        self.assertEqual(patches[0][2]["json"], {"enabled": True})

    def test_delete_and_test_use_query_params(self):
        _app()
        page = self._page()
        with _inline_bg(page), \
             mock.patch.object(QMessageBox, "question",
                               return_value=QMessageBox.StandardButton.Yes):
            page._delete(7)
        page._test(7)
        deletes = [c for c in page.api.calls if c[0] == "delete"]
        tests = [c for c in page.api.calls if c[0] == "post" and c[1][0] == "/api/webhooks/test"]
        self.assertEqual(deletes[0][2]["params"], {"id": 7})
        self.assertEqual(tests[0][2]["params"], {"id": 7})

    def test_secret_reveal_on_cell_click(self):
        _app()
        page = self._page()
        page._apply([
            {"id": 1, "url": "https://x/hook", "secret": "topsecret",
             "events_filter": "*", "enabled": 1, "created_at": 0}
        ])
        self.assertEqual(page.table.item(0, 1).text(), "••••••••")
        page._cell_clicked(0, 1)
        self.assertEqual(page.table.item(0, 1).text(), "topsecret")
        page._cell_clicked(0, 1)
        self.assertEqual(page.table.item(0, 1).text(), "••••••••")


class PlatformSwitchTests(unittest.TestCase):
    def _page(self):
        from api_gateway_app.pages.keys import KeysPage
        return KeysPage(_FakeApi())

    def test_switch_state_from_enabled_counts(self):
        _app()
        from PyQt6.QtWidgets import QPushButton
        page = self._page()
        platforms = [{"platform": "p1", "healthyKeys": 1, "totalKeys": 3}]

        def master_text():
            cell = page.built_in_table.cellWidget(0, 3)
            return cell.findChildren(QPushButton)[0].text()

        # 2 of 3 keys enabled → "Partial (2/3)"
        page._populate_built_ins(platforms, {"p1": (2, 3)})
        self.assertEqual(master_text(), "Partial (2/3)")
        # 3 of 3 → "All on"; none → "All off"
        page._populate_built_ins(platforms, {"p1": (3, 3)})
        self.assertEqual(master_text(), "All on")
        page._populate_built_ins(platforms, {})
        self.assertEqual(master_text(), "All off")

    def test_toggle_platform_patches_all_keys_route(self):
        _app()
        page = self._page()
        button = mock.Mock()
        button.text.return_value = "All off"  # pressing it turns everything on
        with _inline_bg(page), \
             mock.patch.object(QMessageBox, "question",
                               return_value=QMessageBox.StandardButton.Yes):
            page._toggle_platform("nvidia", button)
        patches = [c for c in page.api.calls if c[0] == "patch"]
        self.assertEqual(patches[0][1][0], "/api/keys/platform/nvidia")
        self.assertEqual(patches[0][2]["json"], {"enabled": True})

    def test_updated_keys_reads_count(self):
        from api_gateway_app.pages.keys import KeysPage
        self.assertEqual(KeysPage._updated_keys({"updatedKeys": 4}), 4)
        self.assertEqual(KeysPage._updated_keys(None), 0)


class KeyRenameTests(unittest.TestCase):
    def _page(self):
        from api_gateway_app.pages.keys import KeysPage
        return KeysPage(_FakeApi())

    def test_rename_patches_label(self):
        _app()
        page = self._page()
        from PyQt6.QtWidgets import QInputDialog
        with _inline_bg(page), \
             mock.patch.object(QInputDialog, "getText",
                               return_value=("new label", True)):
            page._rename_key(42, "old label")
        patches = [c for c in page.api.calls if c[0] == "patch" and c[1][0] == "/api/keys/42"]
        self.assertEqual(patches[0][2]["json"], {"label": "new label"})

    def test_rename_cancelled_touches_nothing(self):
        _app()
        page = self._page()
        from PyQt6.QtWidgets import QInputDialog
        with _inline_bg(page), \
             mock.patch.object(QInputDialog, "getText",
                               return_value=("ignored", False)):
            page._rename_key(42, "old label")
        self.assertEqual(page.api.calls, [])


class TokenBudgetBarTests(unittest.TestCase):
    def test_hidden_without_budget(self):
        _app()
        bar = TokenBudgetBar()
        bar.set_data({"totalBudget": 0, "totalUsed": 5, "models": []})
        self.assertFalse(bar.isVisible())

    def test_visible_with_budget(self):
        _app()
        bar = TokenBudgetBar()
        bar.set_data({"totalBudget": 100, "totalUsed": 40, "models": [
            {"displayName": "A", "platform": "x", "budget": 60},
        ]})
        self.assertTrue(bar.isVisible())
        self.assertEqual(bar._total_budget, 100)
        self.assertEqual(len(bar._models), 1)

    def test_garbage_data_is_neutralized(self):
        _app()
        bar = TokenBudgetBar()
        bar.set_data("nonsense")
        self.assertFalse(bar.isVisible())
        self.assertEqual(bar._total_budget, 0)


class FmtTokensTests(unittest.TestCase):
    def test_compact_units(self):
        self.assertEqual(_fmt_tokens(1250), "1.2K")  # 1.25 banker's-rounds to 1.2
        self.assertEqual(_fmt_tokens(3_500_000), "3.5M")
        self.assertEqual(_fmt_tokens(1_900_000_000), "1.9B")
        self.assertEqual(_fmt_tokens(999), "999")

    def test_garbage(self):
        self.assertEqual(_fmt_tokens(None), "0")
        self.assertEqual(_fmt_tokens("x"), "0")


class InventoryLabelTests(unittest.TestCase):
    def test_apply_inventory_labels_checkboxes(self):
        _app()
        from api_gateway_app.pages.settings import SettingsPage
        page = SettingsPage(_FakeApi())
        page._apply_inventory({"models": 2159, "api_keys": 124})
        self.assertIn("2159 rows", page._section_checks["models"].text())
        self.assertIn("124 rows", page._section_checks["api_keys"].text())

    def test_non_int_counts_ignored(self):
        _app()
        from api_gateway_app.pages.settings import SettingsPage
        page = SettingsPage(_FakeApi())
        before = page._section_checks["models"].text()
        page._apply_inventory({"models": "lots"})
        self.assertEqual(page._section_checks["models"].text(), before)


if __name__ == "__main__":
    unittest.main()
