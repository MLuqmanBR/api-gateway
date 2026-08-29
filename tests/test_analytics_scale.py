"""Scale-fix tests for the analytics/dashboard number formatting.

The server sends successRate on the 0-100 scale (41.9 == 41.9%).  The
desktop multiplied by 100 again (4190%) and computed negative error
counts from it.  These tests lock the normalization helpers.
"""

from __future__ import annotations

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from api_gateway_app.pages.analytics import (  # noqa: E402
    as_percent,
    errors_count,
    fmt_money,
)


class AsPercentTests(unittest.TestCase):
    def test_server_scale_passthrough(self):
        """41.9 (already percent) stays 41.9 — the 4190% regression."""
        self.assertEqual(as_percent(41.9), 41.9)
        self.assertEqual(as_percent(0), 0.0)
        self.assertEqual(as_percent(100), 100.0)

    def test_fraction_scale_guard(self):
        """A genuine 0-1 fraction (0.5 == 50%) is promoted, not passed."""
        self.assertEqual(as_percent(0.5), 50.0)
        self.assertEqual(as_percent(1), 100.0)  # 1 → 100% (edge: exactly 1)
        self.assertEqual(as_percent(0.0), 0.0)

    def test_garbage_is_zero(self):
        self.assertEqual(as_percent(None), 0.0)
        self.assertEqual(as_percent("n/a"), 0.0)


class ErrorsCountTests(unittest.TestCase):
    def test_percent_scale(self):
        """100 requests at 41.9% success → 58 errors (never negative)."""
        self.assertEqual(errors_count(100, 41.9), 58)

    def test_never_negative(self):
        self.assertEqual(errors_count(100, 200), 0)

    def test_fraction_scale(self):
        self.assertEqual(errors_count(100, 0.5), 50)

    def test_garbage_is_zero(self):
        self.assertEqual(errors_count(None, None), 0)


class MoneyTests(unittest.TestCase):
    def test_four_decimals(self):
        self.assertEqual(fmt_money(0.123456), "$0.1235")
        self.assertEqual(fmt_money(0), "$0.0000")

    def test_garbage(self):
        self.assertEqual(fmt_money("x"), "$0.0000")


if __name__ == "__main__":
    unittest.main()
