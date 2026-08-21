"""Smoke tests for the HTTP client + the app's non-GUI glue.

These run headless: no QApplication, no display server required.
"""

from __future__ import annotations

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from api_gateway_app import systemd as sysd
from api_gateway_app.backend import ApiClient, ApiError, DEFAULT_BASE_URL


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence test server logging
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if self.path == "/api/auth/login":
            self.send_header("Set-Cookie", "sg_session=deadbeef; HttpOnly; Path=/")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/ping":
            self._json({"status": "ok"})
        elif self.path == "/api/middle/config":
            self._json({"middle_redaction_enabled": "1", "middle_interceptor_timeout_ms": "30000"})
        elif self.path == "/api/auth/status":
            self._json({"needsSetup": False, "authenticated": True, "hasSession": True, "email": None})
        else:
            self._json({"error": {"message": "not found"}}, status=404)

    def do_POST(self):
        if self.path == "/api/auth/login":
            self._json({"success": True})
        elif self.path == "/api/keys/client":
            self._json({"id": "ck_1", "key": "ck_1:supersecret"})
        else:
            self._json({"ok": True})

    def do_PUT(self):
        if self.path.startswith("/api/middle/config"):
            self._json({"saved": True})
        else:
            self._json({"ok": True})

    def do_DELETE(self):
        if self.path.startswith("/api/keys/42"):
            self._json({"deleted": True})
        else:
            self._json({"error": {"message": "missing id query parameter", "type": "invalid_request_error"}}, 400)


class _ServerFixture:
    def __init__(self, handler_cls=None):
        self.handler_cls = handler_cls or _Handler

    def __enter__(self):
        self.server = HTTPServer(("127.0.0.1", 0), self.handler_cls)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def __exit__(self, *exc):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()


class _AuthHandler(BaseHTTPRequestHandler):
    """Simulates the real gateway's login/gated-token behavior.

    - ``POST /api/auth/login`` returns a session token (like the real server).
    - ``GET /api/auth/status`` mirrors LAN-trust semantics.
    - ``GET /api/settings/api-key`` (unified key) is session-gated: 401 unless
      the ``x-dashboard-token`` header matches the issued token — exactly like
      server ``requireSession``.
    """

    SERVICE_TOKEN = "service-token-abc"

    def log_message(self, *args):
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/auth/status":
            self._json({"needsSetup": False, "authenticated": True, "hasSession": True, "email": None})
        elif self.path == "/api/settings/api-key":
            if self.headers.get("x-dashboard-token") == self.SERVICE_TOKEN:
                self._json({"apiKey": "api-gateway-unified123"})
            else:
                self._json({"error": {"message": "Authentication required", "type": "authentication_error"}}, 401)
        else:
            self._json({"error": {"message": "not found"}}, 404)

    def do_POST(self):
        if self.path == "/api/auth/login":
            # Wrong password → the same 401 the real server returns for bad
            # credentials; the login dialog handles it inline.
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
            if body.get("password") == "wrongpass":
                self._json({"error": {"message": "Invalid email or password", "type": "authentication_error"}}, 401)
            else:
                self._json({"token": self.SERVICE_TOKEN, "email": "a@b.c"})
        else:
            self._json({"ok": True})


class ApiClientTests(unittest.TestCase):
    def test_get_ping(self):
        with _ServerFixture() as base:
            client = ApiClient(base_url=base)
            self.addCleanup(client.close)
            self.assertEqual(client.get("/api/ping"), {"status": "ok"})

    def test_get_config_map(self):
        with _ServerFixture() as base:
            client = ApiClient(base_url=base)
            self.addCleanup(client.close)
            cfg = client.get("/api/middle/config")
            self.assertEqual(cfg["middle_redaction_enabled"], "1")

    def test_post_and_cookie_persist(self):
        with _ServerFixture() as base:
            client = ApiClient(base_url=base)
            self.addCleanup(client.close)
            client.post("/api/auth/login", json={"email": "a@b.c", "password": "x"})
            self.assertTrue(any(c.name == "sg_session" for c in client.cookies.jar))

    def test_error_propagates_message(self):
        with _ServerFixture() as base:
            client = ApiClient(base_url=base)
            self.addCleanup(client.close)
            with self.assertRaises(ApiError) as ctx:
                client.delete("/api/middle/secrets")
            self.assertEqual(ctx.exception.status, 400)
            self.assertIn("id query parameter", str(ctx.exception))

    def test_base_url_is_localhost_3001(self):
        self.assertEqual(DEFAULT_BASE_URL, "http://127.0.0.1:3001")

    # -- dashboard session auth -------------------------------------------

    def test_login_captures_token(self):
        with _ServerFixture(_AuthHandler) as base:
            client = ApiClient(base_url=base)
            self.addCleanup(client.close)
            token = client.login("a@b.c", "correct-horse")
            self.assertEqual(token, _AuthHandler.SERVICE_TOKEN)
            self.assertEqual(client.auth_token, _AuthHandler.SERVICE_TOKEN)

    def test_gated_endpoint_returns_401_without_token(self):
        with _ServerFixture(_AuthHandler) as base:
            client = ApiClient(base_url=base)
            self.addCleanup(client.close)
            with self.assertRaises(ApiError) as ctx:
                client.get("/api/settings/api-key")
            self.assertEqual(ctx.exception.status, 401)

    def test_logged_in_client_sends_token_header(self):
        # The unified API key endpoint only answers when the client presents
        # the session token (x-dashboard-token) — this is exactly the export /
        # unified-key flow that previously 401'd in the app.
        with _ServerFixture(_AuthHandler) as base:
            client = ApiClient(base_url=base)
            self.addCleanup(client.close)
            client.login("a@b.c", "correct-horse")
            payload = client.get("/api/settings/api-key")
            self.assertEqual(payload, {"apiKey": "api-gateway-unified123"})

    def test_401_fires_unauthorized_signal(self):
        from PyQt6.QtCore import Qt

        fired = []
        with _ServerFixture(_AuthHandler) as base:
            client = ApiClient(base_url=base)
            self.addCleanup(client.close)
            client._auth_events.unauthorized.connect(
                lambda: fired.append(True), Qt.ConnectionType.DirectConnection)
            with self.assertRaises(ApiError):
                client.get("/api/settings/api-key")
        self.assertEqual(fired, [True], "a 401 on a gated endpoint must fire the unauthorized gate")

    def test_bad_login_does_not_fire_unauthorized(self):
        from PyQt6.QtCore import Qt

        fired = []
        with _ServerFixture(_AuthHandler) as base:
            client = ApiClient(base_url=base)
            self.addCleanup(client.close)
            client._auth_events.unauthorized.connect(
                lambda: fired.append(True), Qt.ConnectionType.DirectConnection)
            # Bad credentials → 401 on /api/auth/login: the login dialog shows
            # the error inline and must NOT re-trigger the auth gate.
            with self.assertRaises(ApiError) as ctx:
                client.login("a@b.c", "wrongpass")
            self.assertEqual(ctx.exception.status, 401)
        self.assertEqual(fired, [], "a 401 from an /api/auth/* route must not fire the gate")

    def test_logout_clears_token(self):
        with _ServerFixture(_AuthHandler) as base:
            client = ApiClient(base_url=base)
            self.addCleanup(client.close)
            client.login("a@b.c", "correct-horse")
            client.auth_token = None
            client.logout()
            self.assertIsNone(client.auth_token)


class SystemdUnitTemplateTests(unittest.TestCase):
    """Pure template-level assertions — never touches a real systemd."""

    def test_repo_root_detection(self):
        root = sysd.repo_root()
        self.assertTrue((root / "package.json").exists())
        self.assertTrue((root / "resources/systemd/api-gateway.service").exists())

    def test_template_renders_repo_root(self):
        import tempfile
        from pathlib import Path

        template = (sysd.repo_root() / sysd.TEMPLATE_REL).read_text(encoding="utf-8")
        self.assertIn("__REPO_ROOT__", template)
        rendered = template.replace("__REPO_ROOT__", str(sysd.repo_root()))
        self.assertIn(f"WorkingDirectory={sysd.repo_root()}", rendered)
        self.assertIn("ExecStart=/usr/bin/env node server/dist/index.js", rendered)
        self.assertIn("[Install]", rendered)
        self.assertIn("WantedBy=default.target", rendered)
        self.assertIn("Restart=on-failure", rendered)

    def test_int_or_none(self):
        self.assertIsNone(sysd._int_or_none(None))
        self.assertIsNone(sysd._int_or_none(""))
        self.assertIsNone(sysd._int_or_none("n/a"))
        self.assertEqual(sysd._int_or_none("0"), 0)
        self.assertEqual(sysd._int_or_none("4242"), 4242)


if __name__ == "__main__":
    unittest.main()
