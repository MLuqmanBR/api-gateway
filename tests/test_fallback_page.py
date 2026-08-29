"""Fallback page tests: filter, per-row enable payload, strategy PUT.

The page previously had no strategy selector, no retry-limit editor, no
per-row enable and no search over the 2,159-row chain.  These tests lock
the new contracts.
"""

from __future__ import annotations

import os
import unittest
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtCore import Qt  # noqa: E402
from PyQt6.QtWidgets import QApplication  # noqa: E402

from api_gateway_app.pages.fallback import FallbackPage, STRATEGIES  # noqa: E402

_APP: QApplication | None = None


def _app() -> QApplication:
    global _APP
    if _APP is None:
        _APP = QApplication.instance() or QApplication([])
    return _APP


class _FakeApi:
    def __init__(self):
        self.calls: list[tuple] = []
        self.responses: dict = {}

    def __getattr__(self, name):
        def _call(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return self.responses.get(name, {})
        return _call


def _chain() -> list[dict]:
    return [
        {"modelDbId": 1, "priority": 1, "enabled": True,
         "displayName": "Alpha Model", "platform": "prov-a"},
        {"modelDbId": 2, "priority": 2, "enabled": True,
         "displayName": "Beta Model", "platform": "prov-b"},
        {"modelDbId": 3, "priority": 3, "enabled": False,
         "displayName": "Gamma Model", "platform": "prov-a"},
    ]


def _inline_bg(page):
    captured: dict = {}

    def _run(fn, on_success=None, on_error=None):
        try:
            captured["result"] = fn()
        except Exception as exc:  # noqa: BLE001
            if on_error:
                on_error(exc)

    return mock.patch.object(page, "call_in_background", side_effect=_run), captured


class FallbackPageTests(unittest.TestCase):
    def setUp(self):
        _app()
        self.page = FallbackPage(_FakeApi())

    def test_apply_populates_and_sets_checkstates(self):
        self.page._apply((_chain(), {"strategy": "balanced"}, {"limit": 3}, {}))
        self.assertEqual(self.page.list.count(), 3)
        self.assertEqual(
            self.page.list.item(2).checkState(), Qt.CheckState.Unchecked
        )
        self.assertEqual(self.page.strategy_box.currentText(), "balanced")
        self.assertEqual(self.page.retry_spin.value(), 3)

    def test_filter_narrows_list(self):
        self.page._apply((_chain(), {}, {}, {}))
        self.page.filter_edit.setText("beta")
        hidden = [self.page.list.item(i).isHidden() for i in range(3)]
        self.assertEqual(hidden, [True, False, True])
        self.page.filter_edit.setText("")
        hidden = [self.page.list.item(i).isHidden() for i in range(3)]
        self.assertEqual(hidden, [False, False, False])

    def test_toggle_then_save_payload_contains_enabled_false(self):
        self.page._apply((_chain(), {}, {}, {}))
        # Toggle the first row's checkbox off (what a user click does).
        item = self.page.list.item(0)
        item.setCheckState(Qt.CheckState.Unchecked)
        self.page._row_toggled(item)
        with _inline_bg(self.page)[0]:
            self.page._save()
        api = self.page.api
        put_calls = [c for c in api.calls if c[0] == "put" and c[1][0] == "/api/fallback"]
        self.assertEqual(len(put_calls), 1)
        payload = put_calls[0][2]["json"]
        self.assertEqual(
            payload[0], {"modelDbId": 1, "priority": 1, "enabled": False}
        )
        # untouched rows keep their enabled state
        self.assertEqual(payload[2]["enabled"], False)
        self.assertEqual(payload[1]["enabled"], True)

    def test_strategy_change_puts_strategy(self):
        self.page._apply((_chain(), {"strategy": "priority"}, {}, {}))
        with _inline_bg(self.page)[0]:
            self.page.strategy_box.setCurrentText("balanced")
        api = self.page.api
        put_calls = [c for c in api.calls if c[0] == "put" and c[1][0] == "/api/fallback/routing"]
        self.assertEqual(len(put_calls), 1)
        self.assertEqual(put_calls[0][2]["json"], {"strategy": "balanced"})

    def test_retry_change_puts_limit(self):
        self.page._apply((_chain(), {}, {"limit": 3}, {}))
        with _inline_bg(self.page)[0]:
            self.page.retry_spin.setValue(7)
        api = self.page.api
        put_calls = [c for c in api.calls if c[0] == "put" and c[1][0] == "/api/fallback/retry-limit"]
        self.assertEqual(len(put_calls), 1)
        self.assertEqual(put_calls[0][2]["json"], {"limit": 7})

    def test_strategies_match_server_enum(self):
        self.assertEqual(
            STRATEGIES,
            ["priority", "balanced", "smartest", "fastest", "reliable", "custom"],
        )


if __name__ == "__main__":
    unittest.main()
