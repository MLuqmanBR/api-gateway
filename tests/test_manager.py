"""Manager tests: mode detection + the duplicate-server invariant.

All subprocess/ping calls are faked; no real systemctl/httpx runs here.
Run with QT_QPA_PLATFORM=offscreen (imported for consistency with the
other GUI-adjacent test modules — manager itself is Qt-free).
"""

from __future__ import annotations

import os
import subprocess
import unittest
from unittest import mock

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from api_gateway_app import manager  # noqa: E402


def _st(
    active: bool = False, pid=None, memory_bytes=None, uptime_s=None
):
    """Fake systemd.ServiceStatus."""
    return manager._sysd.ServiceStatus(
        active=active, pid=pid, memory_bytes=memory_bytes, uptime_s=uptime_s
    )


class EnsureRunningTests(unittest.TestCase):
    """The duplicate-server invariant lives here."""

    def test_ping_ok_starts_nothing(self):
        """Server already answering /api/ping → NO subprocess may run."""
        with mock.patch.object(manager, "ping_ok", return_value=True), \
             mock.patch.object(manager, "_run") as run, \
             mock.patch.object(manager._sysd, "start_service") as sysd_start, \
             mock.patch.object(manager, "api_cli_path", return_value="/usr/bin/api"):
            self.assertTrue(manager.ensure_running())
            run.assert_not_called()
            sysd_start.assert_not_called()

    def test_ping_fail_cli_on_path_calls_api_start(self):
        """api CLI present → `api start` runs and ping is polled to OK."""
        pings = iter([False, True])  # pre-check fails, post-start ping OK

        def fake_ping():
            return next(pings)

        with mock.patch.object(manager, "ping_ok", side_effect=fake_ping), \
             mock.patch.object(manager, "api_cli_path", return_value="/usr/bin/api"), \
             mock.patch.object(manager, "_run") as run, \
             mock.patch("time.sleep"):
            self.assertTrue(manager.ensure_running())
            run.assert_called_once_with(["/usr/bin/api", "start"], timeout=120.0)

    def test_ping_fail_no_cli_unit_installed_uses_systemd(self):
        with mock.patch.object(manager, "ping_ok", return_value=False), \
             mock.patch.object(manager, "api_cli_path", return_value=None), \
             mock.patch.object(manager._sysd, "service_installed", return_value=True), \
             mock.patch.object(manager._sysd, "start_service") as sysd_start, \
             mock.patch.object(manager, "_wait_for_ping", return_value=True) as wait:
            self.assertTrue(manager.ensure_running())
            sysd_start.assert_called_once()
            wait.assert_called_once()

    def test_ping_fail_no_cli_no_unit_gives_up(self):
        with mock.patch.object(manager, "ping_ok", return_value=False), \
             mock.patch.object(manager, "api_cli_path", return_value=None), \
             mock.patch.object(manager._sysd, "service_installed", return_value=False):
            self.assertFalse(manager.ensure_running())


class StatusTests(unittest.TestCase):
    def test_systemd_active(self):
        with mock.patch.object(manager._sysd, "is_service_running", return_value=True), \
             mock.patch.object(manager._sysd, "service_status",
                               return_value=_st(True, pid=42, memory_bytes=1048576, uptime_s=61.0)):
            st = manager.status()
            self.assertTrue(st.running)
            self.assertIs(st.mode, manager.BackendMode.SYSTEMD)
            self.assertEqual(st.pid, 42)

    def test_cli_mode(self):
        """Unit inactive but ping OK → CLI (this machine's shape)."""
        with mock.patch.object(manager._sysd, "is_service_running", return_value=False), \
             mock.patch.object(manager, "ping_ok", return_value=True):
            st = manager.status()
            self.assertTrue(st.running)
            self.assertIs(st.mode, manager.BackendMode.CLI)
            self.assertIsNone(st.pid)

    def test_none_mode(self):
        with mock.patch.object(manager._sysd, "is_service_running", return_value=False), \
             mock.patch.object(manager, "ping_ok", return_value=False):
            st = manager.status()
            self.assertFalse(st.running)
            self.assertIs(st.mode, manager.BackendMode.NONE)


class StopRestartTests(unittest.TestCase):
    def test_stop_cli_uses_api_stop(self):
        with mock.patch.object(manager, "status",
                               return_value=manager.BackendStatus(True, manager.BackendMode.CLI)), \
             mock.patch.object(manager, "api_cli_path", return_value="/usr/bin/api"), \
             mock.patch.object(manager, "_run") as run:
            manager.stop()
            run.assert_called_once_with(["/usr/bin/api", "stop"], timeout=60.0)

    def test_stop_systemd_uses_unit_stop(self):
        with mock.patch.object(manager, "status",
                               return_value=manager.BackendStatus(True, manager.BackendMode.SYSTEMD)), \
             mock.patch.object(manager._sysd, "stop_service") as stop:
            manager.stop()
            stop.assert_called_once()

    def test_stop_none_is_noop(self):
        with mock.patch.object(manager, "status",
                               return_value=manager.BackendStatus(False, manager.BackendMode.NONE)), \
             mock.patch.object(manager, "_run") as run:
            manager.stop()
            run.assert_not_called()

    def test_restart_cli_uses_api_restart(self):
        with mock.patch.object(manager, "status",
                               return_value=manager.BackendStatus(True, manager.BackendMode.CLI)), \
             mock.patch.object(manager, "api_cli_path", return_value="/usr/bin/api"), \
             mock.patch.object(manager, "_run") as run:
            manager.restart()
            run.assert_called_once_with(["/usr/bin/api", "restart"], timeout=120.0)

    def test_label_cli(self):
        st = manager.BackendStatus(True, manager.BackendMode.CLI)
        self.assertEqual(manager.label(st), "api CLI · running")

    def test_label_systemd(self):
        st = manager.BackendStatus(True, manager.BackendMode.SYSTEMD)
        self.assertEqual(manager.label(st), "Service · running")


class SubprocessShapeTests(unittest.TestCase):
    """_run never raises (check=False) — even on non-zero exit."""

    def test_run_swallows_exit_code(self):
        with mock.patch.object(subprocess, "run") as spr:
            spr.return_value = subprocess.CompletedProcess(
                args=["api"], returncode=1, stdout="", stderr="boom"
            )
            result = manager._run(["api", "stop"])
            self.assertEqual(result.returncode, 1)


if __name__ == "__main__":
    unittest.main()
