# SPDX-License-Identifier: MIT
# Copyright (c) 2026 epicodic
"""Public response schema for the effective price table."""

from pydantic import BaseModel

from agentprof.pricing import PriceTable


class ModelPriceOut(BaseModel):
    """USD rate per million tokens for each token kind."""

    input: float
    output: float
    cache_read: float
    cache_write_5m: float
    cache_write_1h: float


class PricingOut(BaseModel):
    """The configured price table and its model matching rule."""

    source: str | None
    date: str | None
    unit: str
    usd_per_credit: float
    matching_rule: str
    models: dict[str, ModelPriceOut]


def pricing_out(table: PriceTable) -> PricingOut:
    """Expose the rates actually used by adapters and the configured metadata."""
    return PricingOut(
        source=table.source,
        date=table.date,
        unit="USD per million tokens",
        usd_per_credit=table.usd_per_credit,
        matching_rule="longest_model_prefix",
        models={prefix: ModelPriceOut(**vars(price)) for prefix, price in table.models.items()},
    )
