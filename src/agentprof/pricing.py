# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Estimate the USD cost of LLM calls from a table of per-model token prices."""

import json
from dataclasses import dataclass
from importlib import resources
from pathlib import Path

from agentprof.model import CostMetric, Provenance

_USD = "USD"
_TOKENS_PER_PRICE_UNIT = 1_000_000
_DEFAULT_USD_PER_CREDIT = 0.01


@dataclass(frozen=True)
class ModelPrice:
    """USD per million tokens."""

    input: float
    output: float
    cache_read: float
    cache_write_5m: float
    cache_write_1h: float


@dataclass(frozen=True)
class Usage:
    """Disjoint token counts of one LLM call."""

    input: int
    output: int
    cache_read: int
    cache_write_5m: int
    cache_write_1h: int


class PriceTable:
    """Model id prefix -> price (the longest matching prefix wins), plus the USD value of one Copilot credit."""

    def __init__(
        self,
        prices: dict[str, ModelPrice],
        usd_per_credit: float = _DEFAULT_USD_PER_CREDIT,
        source: str | None = None,
        date: str | None = None,
    ) -> None:
        self._prices = prices
        self.usd_per_credit = usd_per_credit
        self.source = source
        self.date = date

    @property
    def models(self) -> dict[str, ModelPrice]:
        """The effective model-prefix prices."""
        return self._prices.copy()

    @staticmethod
    def load(path: Path | None = None) -> "PriceTable":
        """Load `path`, or the bundled `pricing.json` if `path` is `None`."""
        if path is None:
            text = resources.files("agentprof").joinpath("pricing.json").read_text(encoding="utf-8")
        else:
            text = path.read_text(encoding="utf-8")
        data = json.loads(text)
        prices = {prefix: ModelPrice(**values) for prefix, values in data["models"].items()}
        return PriceTable(
            prices,
            usd_per_credit=float(data.get("usd_per_credit", _DEFAULT_USD_PER_CREDIT)),
            source=data.get("source"),
            date=data.get("date"),
        )

    def matching_prefix(self, model: str | None) -> str | None:
        """Return the longest price-table prefix matching a full model ID."""
        if model is None:
            return None
        matches = (prefix for prefix in self._prices if model.startswith(prefix))
        return max(matches, key=len, default=None)

    def price_for(self, model: str | None) -> ModelPrice | None:
        prefix = self.matching_prefix(model)
        return self._prices[prefix] if prefix is not None else None

    def cost_parts(self, model: str | None, usage: Usage) -> dict[str, CostMetric]:
        """Estimated USD cost for each disjoint token kind, or unavailable when unpriced."""
        price = self.price_for(model)
        if price is None:
            return {
                kind: CostMetric.not_available()
                for kind in ("input", "output", "cache_read", "cache_write_5m", "cache_write_1h")
            }
        return {
            "input": CostMetric(usage.input * price.input / _TOKENS_PER_PRICE_UNIT, _USD, Provenance.ESTIMATED),
            "output": CostMetric(usage.output * price.output / _TOKENS_PER_PRICE_UNIT, _USD, Provenance.ESTIMATED),
            "cache_read": CostMetric(
                usage.cache_read * price.cache_read / _TOKENS_PER_PRICE_UNIT, _USD, Provenance.ESTIMATED
            ),
            "cache_write_5m": CostMetric(
                usage.cache_write_5m * price.cache_write_5m / _TOKENS_PER_PRICE_UNIT, _USD, Provenance.ESTIMATED
            ),
            "cache_write_1h": CostMetric(
                usage.cache_write_1h * price.cache_write_1h / _TOKENS_PER_PRICE_UNIT, _USD, Provenance.ESTIMATED
            ),
        }

    def cost(self, model: str | None, usage: Usage) -> CostMetric:
        """Estimated USD cost of one call, or `n/a` if the model has no price."""
        price = self.price_for(model)
        if price is None:
            return CostMetric.not_available()
        value = (
            usage.input * price.input
            + usage.output * price.output
            + usage.cache_read * price.cache_read
            + usage.cache_write_5m * price.cache_write_5m
            + usage.cache_write_1h * price.cache_write_1h
        ) / _TOKENS_PER_PRICE_UNIT
        return CostMetric(value=value, unit=_USD, provenance=Provenance.ESTIMATED)
