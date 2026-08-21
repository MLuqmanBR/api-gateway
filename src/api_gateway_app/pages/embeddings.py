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
        # H27: real columns from the server's EmbeddingsData/UsageData shapes.
        configure_table(self.chains, ["Family", "Providers", "Monthly tokens", "Requests today"])
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
        # H27: real shapes — GET /api/embeddings →
        # { defaultFamily, families: [{ family, isDefault, providers: [...] }] };
        # GET /api/embeddings/usage → { families: [{ family, requestsToday,
        # tokensMonth }] } (the old code read nonexistent `keys` /
        # top-level-map fields — every cell was empty or 0).
        usage_map: dict = {}
        if isinstance(usage, dict) and isinstance(usage.get("families"), list):
            for u in usage["families"]:
                if isinstance(u, dict):
                    usage_map[u.get("family")] = u
        families = chains.get("families", []) if isinstance(chains, dict) else (chains if isinstance(chains, list) else [])
        data = []
        for fam in families:
            if not isinstance(fam, dict):
                continue
            name = fam.get("family", "") + ("  (default)" if fam.get("isDefault") else "")
            providers = ", ".join(
                p.get("displayName") or p.get("modelId", "")
                for p in fam.get("providers", []) if isinstance(p, dict)
            )
            u = usage_map.get(fam.get("family")) or {}
            data.append([name, providers, f"{u.get('tokensMonth', 0):,}", f"{u.get('requestsToday', 0):,}"])
        fill_table(self.chains, data)

    def _sync(self):
        # M81: "Re-sync models" is the model catalog sync (POST
        # /api/models/sync-all) — the old empty-body PUT to /api/embeddings
        # was the family-CONFIG save route and risked wiping it.
        self.call_in_background(
            lambda: self.api.post("/api/models/sync-all"),
            on_success=lambda _r: (Toaster.show("Model catalog re-synced", "success"), self.refresh()),
            on_error=lambda e: Toaster.show(str(e), "error"),
        )
