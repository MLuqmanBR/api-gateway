"""Budgets page — create/view/reset/delete request budgets."""

from __future__ import annotations

from typing import Any

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QComboBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QProgressBar,
    QPushButton,
    QVBoxLayout,
)

from ..widgets.floating_bar import FloatingBar
from ..widgets.toast import Toaster
from .base import BasePage

# H26: the server's budget scope enum is ONLY ['client_key', 'global']
# (routes/budgets.ts) — 'platform'/'model' were rejected with 400.
SCOPES = ["global", "client_key"]


class BudgetPage(BasePage):
    title = "Budget"

    def __init__(self, api, parent=None):
        super().__init__(api, parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 26, 28, 24)
        layout.setSpacing(18)

        title = QLabel("Budgets")
        layout.addWidget(title)
        self.hint = QLabel(
            "Cap how much the gateway can spend per scope. Values are US dollars per period; leave any field empty for no limit."
        )
        self.hint.setWordWrap(True)
        layout.addWidget(self.hint)
        layout.addWidget(self.error_label)

        from ..widgets.styled import style_hero_title, style_page_subtitle, watch_style
        watch_style(lambda: style_hero_title(title))
        watch_style(lambda: style_page_subtitle(self.hint))
        style_hero_title(title)
        style_page_subtitle(self.hint)

        # Form
        form_box = QFormLayout()
        self.scope = QComboBox()
        self.scope.addItems(SCOPES)
        self.scope_id = QLineEdit()
        self.scope_id.setPlaceholderText("Client key / platform / model — only for those scopes")
        self.scope_id.setFixedHeight(38)
        self.daily = QLineEdit()
        self.daily.setFixedHeight(38)
        self.daily.setPlaceholderText("e.g. 5.00")
        self.weekly = QLineEdit()
        self.weekly.setFixedHeight(38)
        self.monthly = QLineEdit()
        self.monthly.setFixedHeight(38)
        form_box.addRow("Scope", self.scope)
        form_box.addRow("Scope ID", self.scope_id)
        form_box.addRow("Daily limit", self.daily)
        form_box.addRow("Weekly limit", self.weekly)
        form_box.addRow("Monthly limit", self.monthly)

        scope_row = QHBoxLayout()
        self.scope.currentTextChanged.connect(self._scope_changed)
        self._scope_changed(self.scope.currentText())
        layout.addLayout(form_box)

        self.bar = FloatingBar()
        self.bar.save_button.clicked.connect(self._save)
        self.bar.discard_button.clicked.connect(self.refresh)
        for edit in (self.scope_id, self.daily, self.weekly, self.monthly):
            edit.textChanged.connect(lambda _t: self._dirty())
        self.scope.currentTextChanged.connect(lambda _t: self._dirty())
        layout.addWidget(self.bar)

        # Usage panel
        usage_title = QLabel("Current usage")
        usage_title.setStyleSheet("font-weight: 700; font-size: 15px; margin-top: 6px;")
        layout.addWidget(usage_title)
        self.usage_area = QVBoxLayout()
        self.usage_area.setSpacing(10)
        layout.addLayout(self.usage_area)
        layout.addStretch()

    # ------------------------------------------------------------------

    def on_show(self):
        self.refresh()

    def _scope_changed(self, scope: str):
        self.scope_id.setEnabled(scope != "global")
        self.scope_id.setPlaceholderText(
            "client key id" if scope == "client_key"
            else f"{scope} slug" if scope != "global"
            else "—"
        )

    def _dirty(self):
        has = any([
            self.scope_id.text().strip() if self.scope.currentText() == "client_key" else "",
            self.daily.text().strip(), self.weekly.text().strip(), self.monthly.text().strip(),
        ])
        if has:
            self.bar.show_bar()

    def refresh(self):
        self.set_loading(True)
        self.call_in_background(
            lambda: self.api.get("/api/budgets"),
            on_success=self._apply_budgets,
        )
        self.bar.hide_bar()

    def _apply_budgets(self, budgets):
        self.set_loading(False)
        budgets = budgets if isinstance(budgets, list) else (budgets.get("budgets") if isinstance(budgets, dict) else []) or []
        while self.usage_area.count():
            item = self.usage_area.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        if not budgets:
            empty = QLabel("No budgets configured.")
            empty.setStyleSheet("color: #a6adc8;")
            self.usage_area.addWidget(empty)
            return
        for b in budgets:
            self.usage_area.addWidget(self._usage_row(b))

    def _usage_row(self, b: dict):
        from PyQt6.QtWidgets import QWidget

        w = QWidget()
        row = QHBoxLayout(w)
        row.setContentsMargins(4, 4, 4, 4)
        # H26: the server sends snake_case integer CENTS
        # (scope_id / {period}_limit_cents / {period}_used_cents).
        label = QLabel(f"{b.get('scope', 'global')} — {b.get('scope_id') or ''}")
        label.setFixedWidth(260)
        row.addWidget(label)
        for period in ("daily", "weekly", "monthly"):
            limit = b.get(f"{period}_limit_cents") if isinstance(b.get(f"{period}_limit_cents"), int) else None
            used = b.get(f"{period}_used_cents") or 0
            bar = QProgressBar()
            bar.setRange(0, 100)
            bar.setValue(int(min(100, (used / limit * 100) if limit else 0)) if limit else 0)
            bar.setFormat(f"{period}: ${used / 100:.2f}" + (f" / ${limit / 100:.2f}" if limit else ""))
            row.addWidget(bar, 1)
        reset = QPushButton("Reset")
        reset.clicked.connect(lambda _=False, s=b.get("scope"), sid=b.get("scope_id"): self._reset(s, sid))
        row.addWidget(reset)
        return w

    # ------------------------------------------------------------------

    def _payload(self) -> dict[str, Any]:
        def _cents(edit: QLineEdit):
            text = edit.text().strip()
            if not text:
                return None
            try:
                return int(round(float(text) * 100))  # H26: server wants integer cents
            except ValueError as exc:
                raise ValueError(f"'{text}' is not a number") from exc

        body: dict[str, Any] = {"scope": self.scope.currentText()}
        if self.scope.currentText() != "global":
            sid = self.scope_id.text().strip()
            if not sid:
                raise ValueError("Scope ID is required for this scope")
            body["scope_id"] = sid
        for key, edit in (
            ("daily_limit_cents", self.daily),
            ("weekly_limit_cents", self.weekly),
            ("monthly_limit_cents", self.monthly),
        ):
            value = _cents(edit)
            if value is not None:
                body[key] = value
        return body

    def _save(self):
        try:
            body = self._payload()
        except ValueError as exc:
            Toaster.show(str(exc), "error")
            return
        self.call_in_background(
            lambda: self.api.post("/api/budgets", json=body),
            on_success=lambda _r: (self.bar.hide_bar(), Toaster.show("Budget saved", "success"), self.refresh()),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )

    def _reset(self, scope, scope_id):
        self.call_in_background(
            lambda: self.api.post("/api/budgets/reset", params={"scope": scope, "scope_id": scope_id})
            if scope_id else self.api.post("/api/budgets/reset", params={"scope": scope}),
            on_success=lambda _r: (Toaster.show("Usage counters reset", "success"), self.refresh()),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )
