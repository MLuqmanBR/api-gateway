"""Embeddings page: view provider chains and embeddings usage."""

from __future__ import annotations

from PyQt6.QtWidgets import QHBoxLayout, QLabel, QPushButton, QTableWidget, QVBoxLayout

from ..backend import ApiError
from ..widgets.table import configure_table, fill_table
from ..widgets.toast import Toaster
from .base import BasePage


class EmbeddingsPage(BasePage):
    title = "Embeddings"

    def __init__(self, api, parent=None):
        super().__init__(api, parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(28, 26, 28, 24)
        layout.setSpacing(14)

        title = QLabel("Embeddings")
        subtitle = QLabel("Provider chains and per-family usage for /v1/embeddings.")
        layout.addWidget(title)
        layout.addWidget(subtitle)
        layout.addWidget(self.error_label)

        from ..widgets.styled import style_hero_title, style_page_subtitle, watch_style
        watch_style(lambda: style_hero_title(title))
        watch_style(lambda: style_page_subtitle(subtitle))
        style_hero_title(title)
        style_page_subtitle(subtitle)

        self.chains = QTableWidget()
        configure_table(self.chains, ["Family", "Providers", "Keys", "Monthly tokens"])
        layout.addWidget(self.chains, 1)

        row = QHBoxLayout()
        sync = QPushButton("Re-sync models")
        sync.clicked.connect(self._sync)
        row.addWidget(sync)
        row.addStretch()
        layout.addLayout(row)

    def on_show(self):
        self.refresh()

    def refresh(self):
        self.set_loading(True)
        self.call_in_background(self._fetch, on_success=self._apply)

    def _fetch(self):
        chains = self.api.get("/api/embeddings") or []
        try:
            usage = self.api.get("/api/embeddings/usage") or {}
        except ApiError:
            usage = {}
        return chains, usage

    def _apply(self, result):
        self.set_loading(False)
        chains, usage = result
        usage_map = usage if isinstance(usage, dict) else {}
        data = []
        families = chains.get("families") if isinstance(chains, dict) else chains
        if not isinstance(families, list):
            families = []
        for fam in families:
            name = fam.get("family", "")
            providers = ", ".join(p.get("platform", str(p)) for p in fam.get("providers", fam.get("chain", []))) if isinstance(fam, dict) else str(fam)
            keys = fam.get("keys", "") if isinstance(fam, dict) else ""
            tokens = usage_map.get(name, {})
            tokens_str = f"{tokens.get('tokens', 0):,}" if isinstance(tokens, dict) else str(tokens)
            data.append([name, providers, keys, tokens_str])
        fill_table(self.chains, data)

    def _sync(self):
        self.call_in_background(
            lambda: self.api.put("/api/embeddings", json={}),
            on_success=lambda _r: (Toaster.show("Embeddings refreshed", "success"), self.refresh()),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )
