"""Step-5 page contracts: export sections, budget delete, embeddings PUT."""

from __future__ import annotations

import os
import unittest
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtWidgets import QApplication, QMessageBox  # noqa: E402

from api_gateway_app.pages.settings import EXPORT_SECTIONS  # noqa: E402


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


class ExportSectionsTests(unittest.TestCase):
    def test_sections_match_server_enum(self):
        """The server's ConfigSection enum has exactly these 10 slugs."""
        self.assertEqual(
            [s for s, _ in EXPORT_SECTIONS],
            [
                "models", "fallback_chain", "custom_providers", "api_keys",
                "client_keys", "budgets", "webhooks",
                "embeddings", "settings", "quirks",
            ],
        )

    def test_every_section_has_a_label(self):
        for slug, label in EXPORT_SECTIONS:
            self.assertTrue(label.strip(), f"empty label for {slug}")


class BudgetDeleteTests(unittest.TestCase):
    def _page(self):
        from api_gateway_app.pages.budget import BudgetPage
        return BudgetPage(_FakeApi())

    def test_delete_url_carries_both_query_params(self):
        _app()
        page = self._page()
        with _inline_bg(page), \
             mock.patch.object(QMessageBox, "question",
                               return_value=QMessageBox.StandardButton.Yes):
            page._delete("client_key", "ck-9")
        api = page.api
        deletes = [c for c in api.calls if c[0] == "delete"]
        self.assertEqual(len(deletes), 1)
        method_args, kwargs = deletes[0][1], deletes[0][2]
        self.assertEqual(method_args[0], "/api/budgets")
        self.assertEqual(kwargs["params"], {"scope": "client_key", "scope_id": "ck-9"})

    def test_delete_global_has_no_scope_id(self):
        _app()
        page = self._page()
        with _inline_bg(page), \
             mock.patch.object(QMessageBox, "question",
                               return_value=QMessageBox.StandardButton.Yes):
            page._delete("global", None)
        deletes = [c for c in page.api.calls if c[0] == "delete"]
        self.assertEqual(deletes[0][2]["params"], {"scope": "global"})

    def test_save_requires_at_least_one_limit(self):
        _app()
        page = self._page()
        with _inline_bg(page):
            # No limit fields filled → must NOT reach the API.
            page._save()
        self.assertEqual(page.api.calls, [])


class EmbeddingsSaveTests(unittest.TestCase):
    def test_save_put_body_shape(self):
        _app()
        from api_gateway_app.pages.embeddings import EmbeddingsPage
        page = EmbeddingsPage(_FakeApi())
        # Seed state as a populated page would have it.
        page._rows = {
            5: {"family": "f1", "provider": {"id": 5}, "priority": 2, "enabled": True},
            9: {"family": "f2", "provider": {"id": 9}, "priority": 1, "enabled": False},
        }
        page.default_box.addItems(["f1", "f2"])
        page.default_box.setCurrentText("f2")
        with _inline_bg(page):
            page._save()
        puts = [c for c in page.api.calls if c[0] == "put" and c[1][0] == "/api/embeddings"]
        self.assertEqual(len(puts), 1)
        body = puts[0][2]["json"]
        self.assertEqual(body["defaultFamily"], "f2")
        self.assertEqual(
            sorted(body["providers"], key=lambda p: p["id"]),
            [
                {"id": 5, "priority": 2, "enabled": True},
                {"id": 9, "priority": 1, "enabled": False},
            ],
        )


if __name__ == "__main__":
    unittest.main()
