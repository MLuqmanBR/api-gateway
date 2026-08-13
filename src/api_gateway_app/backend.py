"""HTTP client + SSE stream for talking to the local api-gateway server."""

from __future__ import annotations

import json
import time
from typing import Any

import httpx
from PyQt6.QtCore import QObject, QThread, Qt, pyqtSignal

DEFAULT_BASE_URL = "http://127.0.0.1:3001"


class _AuthEvents(QObject):
    """Fires when the server rejects a session-gated request with 401.

    Queued so the desktop app can pop the login dialog on the GUI thread even
    when the 401 was raised from a worker-thread fetch.
    """
    unauthorized = pyqtSignal()


class ApiError(RuntimeError):
    def __init__(self, message: str, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class ApiClient:
    """Synchronous HTTP client with a persistent session.

    Thread-safe for concurrent use *only* when callers do not mutate shared
    state; pages call it from worker threads for fetches and from the GUI
    thread for user actions.  The server side is stateless HTTP, so this is
    fine for our purposes.
    """

    def __init__(self, base_url: str = DEFAULT_BASE_URL, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.auth_token: str | None = None
        self._auth_events = _AuthEvents()
        self._client = httpx.Client(
            base_url=self.base_url,
            timeout=httpx.Timeout(timeout, connect=2.0),
            follow_redirects=True,
        )

    # -- auth -------------------------------------------------------------

    def connect_unauthorized(self, callback) -> None:
        """Call ``callback`` (on the GUI thread) when a 401 hits a gated endpoint."""
        self._auth_events.unauthorized.connect(callback, Qt.ConnectionType.QueuedConnection)

    def login(self, email: str, password: str) -> str:
        """Sign in, store the returned session token, return it."""
        data = self.post("/api/auth/login", json={"email": email, "password": password})
        token = data.get("token") if isinstance(data, dict) else None
        if token:
            self.auth_token = token
        return token or ""

    def setup(self, email: str, password: str) -> str:
        """Create the first dashboard account, store the session token, return it."""
        data = self.post("/api/auth/setup", json={"email": email, "password": password})
        token = data.get("token") if isinstance(data, dict) else None
        if token:
            self.auth_token = token
        return token or ""

    def logout(self) -> None:
        """Best-effort revoke of the current session; clears the local token."""
        try:
            if self.auth_token:
                self._request_unchecked("POST", "/api/auth/logout")
        except ApiError:
            pass
        self.auth_token = None

    def auth_headers(self) -> dict:
        return {"x-dashboard-token": self.auth_token} if self.auth_token else {}

    # -- low-level ---------------------------------------------------------

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = path if path.startswith("http") else path
        headers = self.auth_headers()
        try:
            response = self._client.request(method, url, headers=headers, **kwargs)
        except httpx.RequestError as exc:
            raise ApiError(f"Cannot reach the server at {self.base_url}: {exc}") from exc
        if response.status_code == 401:
            # Only session-gated admin routes hit this; the /api/auth/* login
            # endpoints are public and their 401 means "bad credentials", which
            # the login dialog handles inline — do not re-trigger the gate.
            if not path.startswith("/api/auth/"):
                self._auth_events.unauthorized.emit()
            raise ApiError("Authentication required", status=401, body=None)
        if not response.is_success:
            message = _extract_error(response)
            raise ApiError(message, status=response.status_code, body=response.text)
        if response.status_code == 204 or not response.content:
            return None
        text = response.text
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise ApiError(f"Expected JSON from {path} but got non-JSON") from exc

    def _request_unchecked(self, method: str, path: str, **kwargs: Any) -> Any:
        """Like ``_request`` but never fires the unauthorized gate (logout)."""
        url = path if path.startswith("http") else path
        try:
            response = self._client.request(method, url, headers=self.auth_headers(), **kwargs)
        except httpx.RequestError:
            return None
        if not response.content:
            return None
        try:
            return json.loads(response.text)
        except json.JSONDecodeError:
            return None

    # -- public API --------------------------------------------------------

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return self._request("GET", path, params=_clean_params(params))

    def post(self, path: str, json: Any = None, **kwargs: Any) -> Any:
        return self._request("POST", path, json=json, **kwargs)

    def put(self, path: str, json: Any = None, **kwargs: Any) -> Any:
        return self._request("PUT", path, json=json, **kwargs)

    def patch(self, path: str, json: Any = None, **kwargs: Any) -> Any:
        return self._request("PATCH", path, json=json, **kwargs)

    def delete(self, path: str, params: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        return self._request("DELETE", path, params=_clean_params(params), **kwargs)

    # Streaming / raw helpers (used by Playground for SSE chat)
    def stream(self, method: str, path: str, **kwargs: Any):
        return self._client.stream(method, path, **kwargs)

    def close(self) -> None:
        self._client.close()

    # -- cookie access (used by tests and the playground auth header) ------
    @property
    def cookies(self) -> httpx.Cookies:
        return self._client.cookies


def _clean_params(params: dict[str, Any] | None) -> dict[str, Any] | None:
    if not params:
        return None
    return {k: v for k, v in params.items() if v is not None and v != ""}


def _extract_error(response: httpx.Response) -> str:
    try:
        data = response.json()
        if isinstance(data, dict):
            error = data.get("error")
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])
            if isinstance(data.get("message"), str):
                return str(data["message"])
    except Exception:  # noqa: BLE001
        pass
    return f"HTTP {response.status_code}: {response.text[:200]}"


class EventStream(QThread):
    """Subscribe to /api/events and emit parsed JSON messages as Qt signals.

    The server sends ``: connected`` as the first line (a comment), then one
    ``data: {json}\\n\\n`` per event.  The auth cookie / LAN trust is attached
    automatically via the shared httpx client cookie jar.
    """

    event_received = pyqtSignal(dict)
    connection_lost = pyqtSignal(str)
    connected = pyqtSignal()

    def __init__(self, client: ApiClient, parent=None):
        super().__init__(parent)
        self._client = client
        self._stop = False

    def run(self) -> None:  # noqa: D401 - Qt thread entry
        backoff = 1.0
        while not self._stop:
            try:
                headers = {"Accept": "text/event-stream", **self._client.auth_headers()}
                with self._client.stream(
                    "GET", "/api/events", headers=headers, timeout=None,
                ) as response:
                    if response.status_code != 200:
                        raise ApiError(f"events stream HTTP {response.status_code}")
                    backoff = 1.0
                    self.connected.emit()
                    self._read_sse(response)
            except Exception as exc:  # noqa: BLE001 - keep the stream alive
                if self._stop:
                    break
                self.connection_lost.emit(str(exc))
                # Exponential backoff capped at 30 s.
                time.sleep(backoff)
                backoff = min(30.0, backoff * 2)

    def _read_sse(self, response: httpx.Response) -> None:
        buffer = ""
        for chunk in response.iter_text():
            if self._stop:
                return
            buffer += chunk
            while "\n\n" in buffer:
                block, _, buffer = buffer.partition("\n\n")
                self._handle_block(block)

    def _handle_block(self, block: str) -> None:
        for line in block.splitlines():
            if line.startswith(":") or not line.strip():
                continue
            if line.startswith("data:"):
                payload = line[5:].strip()
                try:
                    message = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                if isinstance(message, dict) and isinstance(message.get("type"), str):
                    self.event_received.emit(message)

    def stop(self) -> None:
        self._stop = True
        # Closing the response is enough to break iter_text; waiting keeps
        # the GUI responsive on quit.
        self.wait(2000)
