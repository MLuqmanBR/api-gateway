"""Ensure every page module + widget imports cleanly under PyQt6.

Run with QT_QPA_PLATFORM=offscreen so no display server is needed.

We do NOT instantiate ``MainWindow`` here, because constructing a QThread-
backed ``EventStream`` against an unreachable backend triggers a QThread
destroyed-while-running abort in the offscreen platform on exit.  The real
app's long-lived QApplication doesn't hit that path.
"""

from __future__ import annotations

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

MODULES = [
    "api_gateway_app.app",
    "api_gateway_app.mainwindow",
    "api_gateway_app.backend",
    "api_gateway_app.systemd",
    "api_gateway_app.systemd_gui",
    "api_gateway_app.manager",
    "api_gateway_app.settings",
    "api_gateway_app.theme",
    "api_gateway_app.qt",
    "api_gateway_app.widgets.nav",
    "api_gateway_app.widgets.statscard",
    "api_gateway_app.widgets.table",
    "api_gateway_app.widgets.floating_bar",
    "api_gateway_app.widgets.auth",
    "api_gateway_app.widgets.toast",
    "api_gateway_app.widgets.live_events",
    "api_gateway_app.pages.base",
    "api_gateway_app.pages.dashboard",
    "api_gateway_app.pages.analytics",
    "api_gateway_app.pages.keys",
    "api_gateway_app.pages.budget",
    "api_gateway_app.pages.playground",
    "api_gateway_app.pages.fallback",
    "api_gateway_app.pages.embeddings",
    "api_gateway_app.pages.middle",
    "api_gateway_app.pages.settings",
]


class ImportTests(unittest.TestCase):
    def test_all_modules_import(self):
        import importlib

        for name in MODULES:
            with self.subTest(module=name):
                importlib.import_module(name)

    def test_page_classes_exist(self):
        from api_gateway_app.pages import (
            analytics,
            budget,
            dashboard,
            embeddings,
            fallback,
            keys,
            middle,
            playground,
            settings,
        )

        for mod in (dashboard, analytics, keys, budget, playground, fallback, embeddings, middle, settings):
            with self.subTest(module=mod.__name__):
                self.assertTrue(
                    any(
                        isinstance(getattr(mod, attr), type)
                        for attr in dir(mod)
                        if not attr.startswith("_")
                    ),
                    f"{mod.__name__} has no class",
                )


if __name__ == "__main__":
    unittest.main()
