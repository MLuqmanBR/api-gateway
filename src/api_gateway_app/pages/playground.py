"""Playground — chat-completions console against the unified key."""

from __future__ import annotations

from PyQt6.QtCore import QThread, pyqtSignal
from PyQt6.QtWidgets import (
    QComboBox,
    QCheckBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QSlider,
    QSplitter,
    QSpinBox,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from ..backend import ApiClient, ApiError
from ..widgets.toast import Toaster
from .base import BasePage


class _ChatWorker(QThread):
    chunk = pyqtSignal(str)
    done = pyqtSignal()
    failed = pyqtSignal(str)

    def __init__(self, api: ApiClient, body: dict, parent=None):
        super().__init__(parent)
        self.api = api
        self.body = body

    def run(self):
        try:
            if self.body.get("stream"):
                self._stream()
            else:
                result = self.api.post("/v1/chat/completions", json={**self.body, "stream": False})
                content = (
                    result.get("choices", [{}])[0].get("message", {}).get("content")
                    if isinstance(result, dict) else None
                )
                self.chunk.emit(content or "(empty response)")
            self.done.emit()
        except ApiError as exc:
            self.failed.emit(str(exc))
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(str(exc))

    def _stream(self):
        import json

        with self.api.stream("POST", "/v1/chat/completions", json=self.body, timeout=None) as resp:
            if resp.status_code != 200:
                self.failed.emit(f"stream HTTP {resp.status_code}")
                return
            for line in resp.iter_lines():
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data:"):
                    payload = line[5:].strip()
                else:
                    payload = line.strip()
                if payload == "[DONE]":
                    break
                try:
                    msg = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                delta = msg.get("choices", [{}])[0].get("delta", {})
                piece = delta.get("content") or delta.get("reasoning_content") or ""
                if piece:
                    self.chunk.emit(piece)


class PlaygroundPage(BasePage):
    title = "Playground"

    def __init__(self, api, parent=None):
        super().__init__(api, parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 26, 28, 24)
        layout.setSpacing(14)

        title = QLabel("Playground")
        subtitle = QLabel("Try the gateway with any model. Streaming supported.")
        layout.addWidget(title)
        layout.addWidget(subtitle)

        from ..widgets.styled import style_hero_title, style_page_subtitle, watch_style
        watch_style(lambda: style_hero_title(title))
        watch_style(lambda: style_page_subtitle(subtitle))
        style_hero_title(title)
        style_page_subtitle(subtitle)

        controls = QHBoxLayout()
        controls.setSpacing(10)
        self.model = QComboBox()
        self.model.setEditable(False)
        self.model.addItem("auto (let gateway route)")
        self.model.setFixedHeight(38)
        controls.addWidget(QLabel("Model"))
        controls.addWidget(self.model, 1)

        controls.addWidget(QLabel("Temp"))
        self.temp = QSlider()
        self.temp.setRange(0, 20)
        self.temp.setValue(10)
        self.temp.setFixedWidth(120)
        controls.addWidget(self.temp)

        controls.addWidget(QLabel("Max tokens"))
        self.max_tokens = QSpinBox()
        self.max_tokens.setRange(1, 128_000)
        self.max_tokens.setValue(1024)
        self.max_tokens.setFixedHeight(38)
        controls.addWidget(self.max_tokens)
        self.stream_box = QCheckBox("Stream")
        self.stream_box.setChecked(True)
        controls.addWidget(self.stream_box)
        layout.addLayout(controls)

        self.system = QLineEdit()
        self.system.setPlaceholderText("System prompt (optional)")
        layout.addWidget(self.system)

        splitter = QSplitter()
        self.history = QTextBrowser()
        self.history.setOpenExternalLinks(False)
        splitter.addWidget(self.history)
        self.raw = QPlainTextEdit()
        self.raw.setReadOnly(True)
        self.raw.setPlaceholderText("Raw request / response JSON appears here")
        splitter.addWidget(self.raw)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        layout.addWidget(splitter, 1)

        input_row = QHBoxLayout()
        input_row.setSpacing(8)
        self.input = QLineEdit()
        self.input.setPlaceholderText("Type a message and press Enter — streaming tokens appear live in the history")
        self.input.setFixedHeight(42)
        self.input.returnPressed.connect(self._send)
        input_row.addWidget(self.input, 1)
        self.send_btn = QPushButton("Send")
        self.send_btn.setObjectName("primary")
        self.send_btn.setFixedHeight(42)
        self.send_btn.setMinimumWidth(100)
        self.send_btn.clicked.connect(self._send)
        input_row.addWidget(self.send_btn)
        layout.addLayout(input_row)
        layout.addWidget(self.error_label)

        self._messages: list[dict] = []
        self._worker: _ChatWorker | None = None
        self._unified_key: str | None = None

    def on_show(self):
        if self.model.count() <= 1:
            self.refresh()
        self._ensure_key()

    def refresh(self):
        self.call_in_background(
            lambda: self.api.get("/api/models"),
            on_success=self._apply_models,
        )

    def _apply_models(self, models):
        items = models if isinstance(models, list) else models.get("models", []) if isinstance(models, dict) else []
        self.model.clear()
        self.model.addItem("auto")
        for m in items:
            if not isinstance(m, dict):
                continue
            usable = m.get("enabled", True) and (m.get("keyCount", 1) or 1) > 0
            if not usable:
                continue
            self.model.addItem(m.get("modelId") or m.get("displayName") or "")

    def _ensure_key(self):
        if self._unified_key:
            return
        self.call_in_background(
            lambda: self.api.get("/api/settings/api-key"),
            on_success=lambda d: setattr(self, "_unified_key", (d or {}).get("apiKey")),
            on_error=lambda e: None,
        )

    # -- send ---------------------------------------------------------------

    def _send(self) -> None:
        text = self.input.text().strip()
        if not text:
            return
        self.input.clear()
        messages = []
        if self.system.text().strip():
            messages.append({"role": "system", "content": self.system.text().strip()})
        messages.extend(self._messages)
        messages.append({"role": "user", "content": text})
        body = {
            "messages": messages,
            "stream": bool(self.stream_box.isChecked()),
            "temperature": self.temp.value() / 10,
            "max_tokens": self.max_tokens.value(),
        }
        if self.model.currentText() != "auto":
            body["model"] = self.model.currentText()

        import json as _json
        self.raw.setPlainText(_json.dumps(body, indent=2))
        self._append("user", text)
        self._messages.append({"role": "user", "content": text})

        self.send_btn.setEnabled(False)
        self._worker = _ChatWorker(self.api, body, self)
        self._assistant_buffer = ""
        self._worker.chunk.connect(self._append_chunk)
        self._worker.done.connect(self._finish)
        self._worker.failed.connect(self._failed)
        self._worker.start()

    # -- rendering -----------------------------------------------------------

    def _append(self, role: str, text: str) -> None:
        color = "#89b4fa" if role == "user" else "#cdd6f4"
        name = "You" if role == "user" else "Assistant"
        self.history.append(f"<b style='color:{color}'>{name}</b><br>{text}<br><br>")

    def _append_chunk(self, chunk: str) -> None:
        self._assistant_buffer += chunk
        cursor = self.history.textCursor()
        cursor.movePosition(cursor.MoveOperation.End)
        cursor.insertHtml(self._escape(chunk))

    def _finish(self):
        text = self._assistant_buffer
        if text:
            self._messages.append({"role": "assistant", "content": text})
            self.history.append("<br>")
        self.send_btn.setEnabled(True)
        self._assistant_buffer = ""

    def _failed(self, message: str):
        Toaster.show(message, "error")
        self.send_btn.setEnabled(True)

    @staticmethod
    def _escape(text: str) -> str:
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")
